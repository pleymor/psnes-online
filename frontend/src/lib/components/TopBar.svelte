<script lang="ts">
  /**
   * Navigation and identity, and nothing else.
   *
   * The sidebar this replaces held four settings, a permanently visible friends
   * list and an "add games" button. Settings went to /profile, friends became a
   * menu opened on demand, and adding games stopped being a repeated action
   * when ROMs went local.
   *
   * Only rendered when signed in. The landing page keeps its own language
   * selector, because /profile is unreachable to someone who has not signed in.
   *
   * The friends feature lives here whole - the list, the details modal it opens
   * and the removal that modal asks for. Removal goes through a method exported
   * by FriendsList, so the reference to it has to sit in the same component as
   * the modal's handler; splitting them across the page boundary is how you get
   * a remove button that silently does nothing.
   *
   * Invitations no longer live here. They were a badge that opened a drawer that
   * held the accept button - two clicks, and only on the two pages that carry
   * this bar. They are now a card mounted in the layout (`InvitationCard`), which
   * appears by itself wherever the player happens to be.
   */
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import FriendsList from './FriendsList.svelte';
  import FriendDetailsModal from './FriendDetailsModal.svelte';
  import { activeRooms } from '$lib/rooms/my-room';
  import { wayBack } from '$lib/nav/way-back';
  import { vrAvailable } from '$lib/vr/support';
  import { requestVr } from '$lib/vr/entry';
  import { folderNeedsGrant, grantFolder, type DoorPorts } from '$lib/vr/door';
  import { missingFromDevice, prepareForVr, type PreparePorts } from '$lib/vr/prepare';
  import {
    supportsDirectoryPicker, storedDirectory, hasAccess, ensureAccess
  } from '$lib/roms/local-library';
  import { readAndKeep } from '$lib/roms/provider';
  import { keptFilesAvailable, indexedDbKeptFiles } from '$lib/roms/kept-files';
  import { indexedChecksums, scanDirectory } from '$lib/roms/local-library';
  import { games } from '$lib/stores/games';
  import { notifications } from '$lib/services/notification';

  /** Undefined until asked, so the button does not flash in and out on load. */
  let headsetHere: boolean | undefined;

  const DOOR: DoorPorts = { supportsDirectoryPicker, storedDirectory, hasAccess, ensureAccess };

  const PREPARE: PreparePorts = {
    keptChecksums: async () => (keptFilesAvailable() ? indexedDbKeptFiles().checksums() : []),
    folderChecksums: async () => (supportsDirectoryPicker() ? indexedChecksums() : []),
    scanFolder: async (handle) => (await scanDirectory(handle)).map((entry) => entry.checksum),
    storedDirectory,
    readAndKeep
  };

  /** The games the headset will offer, which are the ones it must be able to open. */
  $: wanted = $games.map((game) => game.crc32).filter((c): c is string => Boolean(c));

  /**
   * Whether anything still has to be read out of the folder.
   *
   * Recomputed whenever the library changes, never inside the click handler:
   * `requestSession` runs on the activation the press carries, and the common
   * path - nothing to prepare - has to stay synchronous from click to session.
   */
  let needsPrepare = false;
  /**
   * Tried once per page, whatever came of it.
   *
   * Without this the door locks: a game that cannot be read here keeps
   * `needsPrepare` true, so every press runs the preparation again and none of
   * them ever reaches `requestVr()`. Shipped exactly that way, and it is the
   * bug this guard exists for - the commit that introduced it claimed
   * "nothing bars the door" while barring it.
   */
  let prepareTried = false;
  $: void refreshPrepareNeed(wanted);
  async function refreshPrepareNeed(list: string[]): Promise<void> {
    if (prepareTried) return;
    needsPrepare = list.length > 0 && (await missingFromDevice(list, PREPARE)).length > 0;
  }

  /**
   * Whether the next press has to buy the folder permission first.
   *
   * Asked here rather than inside the handler so the common path stays
   * synchronous - see `folderNeedsGrant`.
   */
  let needsGrant = false;

  onMount(async () => {
    headsetHere = await vrAvailable();
    needsGrant = await folderNeedsGrant(DOOR);
  });

  /**
   * Synchronous whenever it can be. `requestSession`, several frames later in
   * `VrShell`, still runs on the activation this click carries; an `await` on
   * the way to `requestVr()` would spend part of that window for nothing.
   */
  function enterVr(): void {
    if (!needsGrant && !needsPrepare) {
      requestVr();
      return;
    }
    void spendPressOnFolder();
  }

  async function spendPressOnFolder(): Promise<void> {
    let granted = false;
    if (needsGrant) {
      const outcome = await grantFolder(DOOR);
      if (outcome === 'refused') {
        needsGrant = true;
        notifications.show(t($language, 'vrFolderRefused'), 'error', 5000);
        return;
      }
      granted = outcome === 'granted';
      needsGrant = false;
      if (outcome === 'entered' && !needsPrepare) {
        // No dialog was shown and there is nothing to read, so the gesture is
        // intact and the player must not be charged a second press for a check
        // they never saw.
        requestVr();
        return;
      }
    }

    if (needsPrepare) await bringGamesOntoTheDevice();

    // Whatever happened above spent the activation `requestSession` needs -
    // a native dialog, or seconds of reading. Asking for another press is
    // honest; entering anyway fails with a message about user activation that
    // means nothing to a player.
    // Two different truths: a folder was authorised, or games were merely read.
    // Saying "folder allowed" after a run that only read files would be false.
    notifications.show(
      t($language, granted ? 'vrFolderGranted' : 'vrReadyPressAgain'),
      'success',
      5000
    );
  }

  /**
   * Reads the library out of the folder, once, so the headset never has to.
   *
   * The reason this exists at all: reading the folder from inside an immersive
   * session never succeeds - see `vr/prepare.ts`. The player had been doing
   * this by hand, one launch per cartridge on the flat page.
   */
  async function bringGamesOntoTheDevice(): Promise<void> {
    // Duration 0, so it stays up for as long as the reading takes; dismissed
    // by hand below. A silent minute would read as a dead button.
    let toast = notifications.show(t($language, 'vrPreparing'), 'info', 0);

    const result = await prepareForVr(wanted, PREPARE, (done, total) => {
      notifications.dismiss(toast);
      toast = notifications.show(`${t($language, 'vrPreparing')} ${done}/${total}`, 'info', 0);
    });

    notifications.dismiss(toast);
    // Unconditionally, and this is the whole point: preparation is a courtesy,
    // never a precondition. A second press must enter the session even if
    // nothing could be read.
    prepareTried = true;
    needsPrepare = false;

    if (result.failed > 0) {
      // Named rather than hidden: these are the games the headset will still
      // refuse to open, and the player is the only one who can find out why.
      notifications.show(
        t($language, 'vrPrepareFailed', { count: String(result.failed) }),
        'warning',
        6000
      );
    }
  }

  /**
   * The labelled way back, on the screens where plain navigation is the right
   * way out - see `way-back.ts` for why that is an allowlist and why the room
   * screen is not on it.
   */
  $: back = wayBack($page.url.pathname);

  let showFriends = false;
  let friendsListRef: FriendsList;
  let selectedFriend: any = null;

  function toggleFriends() {
    showFriends = !showFriends;
  }

  function handleFriendClicked(event: CustomEvent<any>) {
    selectedFriend = event.detail;
  }

  async function handleRemoveFriend(event: CustomEvent<{ friendshipId: string }>) {
    const { friendshipId } = event.detail;

    if (friendsListRef) {
      await friendsListRef.removeFriend(friendshipId);
      selectedFriend = null;
    }
  }
</script>

<header class="top-bar">
  <div class="left">
    <!--
      The brand still goes home, because it always has and people who know that
      convention keep using it. It is no longer the only thing that does.
    -->
    <a class="brand" class:redundant={!!back} href="/">🎮 PSNES</a>

    {#if back}
      <!--
        Said in words, and wearing the bar's own button shape: the whole finding
        behind this is that a way back which has to be guessed at is not one.
        The arrow is decoration next to the label, not a substitute for it.
      -->
      <a class="bar-button back" href={back.href}>
        <span aria-hidden="true">←</span>
        {t($language, back.label)}
      </a>
    {/if}
  </div>

  <div class="right">
    {#if headsetHere}
      <!-- Capability, never a user agent: this button appears on a Quest and
           on a PC with a headset plugged in, and the "two controllers and
           nothing else" assumption only has to hold inside the session. -->
      <button
        class="bar-button"
        title={t($language, 'vrSeatedTitle')}
        on:click={enterVr}
      >
        {t($language, 'enterVr')}
      </button>
      <!-- Beside the button, not under it: this bar is a centred flex row and a
           second line would change its height on every page. Only rendered
           where the button is, so a PC with no headset never sees it. -->
      <span class="vr-hint">{t($language, 'vrSeatedHint')}</span>
    {/if}

    <button class="bar-button" class:on={showFriends} on:click={toggleFriends}>
      {t($language, 'friends')}
    </button>

    <a class="avatar" href="/profile" title={$user?.pseudo ?? ''}>
      {#if $user?.avatar}
        <img src={$user.avatar} alt={$user.pseudo} />
      {:else}
        <span class="placeholder">👤</span>
      {/if}
    </a>
  </div>
</header>

{#if showFriends}
  <!-- A dropdown on a wide screen, the whole screen on a narrow one: a friends
       list in a narrow column is not readable, which is the same reason the
       pause panel makes the same split.

       The full layout, not the compact one: compact is a strip of avatars with
       no way to add a friend and no way to accept a request, and the bar is now
       the only place either is reachable from. The drawer is 24rem wide, which
       is what the full layout was built for in the sidebar. -->
  <div class="friends-drawer">
    <FriendsList bind:this={friendsListRef} activeRooms={$activeRooms} on:friendClicked={handleFriendClicked} />
  </div>
{/if}

{#if selectedFriend}
  <FriendDetailsModal
    friend={selectedFriend.friend}
    friendsSince={selectedFriend.friendsSince}
    friendshipId={selectedFriend.friendshipId}
    on:close={() => (selectedFriend = null)}
    on:remove={handleRemoveFriend}
  />
{/if}

<style>
  .top-bar {
    /* Pinned, so the drawer below can be positioned against the viewport. */
    position: sticky;
    top: 0;
    z-index: 101;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 1rem;
    background: #1a1a1a;
    border-bottom: 1px solid #2e2e2e;
  }

  .left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .brand {
    color: #fff;
    text-decoration: none;
    font-weight: 600;
  }

  .right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .bar-button {
    background: #2a2a2a;
    border: 2px solid transparent;
    color: #fff;
    padding: 0.35rem 0.7rem;
    border-radius: 6px;
    cursor: pointer;
  }

  /* Quiet on purpose: it is a caption for the button next to it, not a
     control, and the bar already has enough things asking to be pressed. */
  .vr-hint {
    color: #8a8a98;
    font-size: 0.78rem;
    white-space: nowrap;
  }

  /* The bar is tight on a phone, and this is the one thing in it that is
     advice rather than function - so it is the first thing to go. */
  @media (max-width: 640px) {
    .vr-hint {
      display: none;
    }
  }

  .bar-button.on {
    background: #3a4a5a;
    border-color: #667eea;
  }

  /* A link that has to read as a control, so it borrows the shape of the one
     control the bar already had rather than introducing a second one. */
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    text-decoration: none;
    white-space: nowrap;
  }

  .avatar {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    overflow: hidden;
    background: #333;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .friends-drawer {
    /* Fixed rather than absolute: the drawer is a SIBLING of the bar, not a
       child, so there is no positioned ancestor to measure from and absolute
       would resolve against the document - correct at the top of the page and
       scrolling away from the bar everywhere else. The bar is pinned to the
       viewport, so the viewport is the right reference for both. */
    position: fixed;
    right: 1rem;
    top: 3rem;
    width: 24rem;
    max-height: 70vh;
    overflow-y: auto;
    background: #1a1a1a;
    border: 1px solid #2e2e2e;
    border-radius: 8px;
    z-index: 100;
  }

  /* No room for both, and they lead to the same place. The one that survives is
     the one that says where it goes: dropping the labelled link and keeping the
     logo would be exactly the bug this change exists to fix, on the screen size
     where it bites hardest. */
  @media (max-width: 480px) {
    .brand.redundant {
      display: none;
    }
  }

  /* Too narrow for a column: take the screen, same reason as the pause panel. */
  @media (max-width: 700px) {
    .friends-drawer {
      position: fixed;
      inset: 3rem 0 0;
      width: auto;
      max-height: none;
      border-radius: 0;
    }
  }
</style>
