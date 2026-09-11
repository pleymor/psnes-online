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
  import { onMount, createEventDispatcher } from 'svelte';
  import { page } from '$app/stores';

  const dispatch = createEventDispatcher<{ searchopen: void; searchclose: void }>();

  /*
   * La recherche dépliée, et le reste de la barre effacé.
   *
   * Mesuré avant d'être décidé : le contenu de cette barre fait 393 px de
   * large, donc sur un écran de 390 la page se met à défiler latéralement et
   * la marque est rognée en un trait. Sous 480 px la recherche se replie donc
   * en une loupe, et l'ouvrir efface Amis, le VR et l'avatar - il n'y a pas
   * de place pour les deux, et « tout, en plus petit » n'existe pas ici.
   *
   * `searching` ne fait rien au-dessus du point de rupture : les règles qui
   * le lisent vivent toutes dans la requête média, donc sur un large écran la
   * barre reste ce qu'elle était, quoi que vaille ce drapeau.
   */
  let searching = false;

  function openSearch() {
    searching = true;
    dispatch('searchopen');
  }

  /*
   * Refermer efface la requête, et c'est la page qui s'en charge - la barre
   * ne connaît pas le champ, elle ne fait que lui prêter sa place. Sans cet
   * effacement la bibliothèque resterait filtrée sans que rien à l'écran ne
   * dise pourquoi : un mode caché, et la pire sorte.
   */
  function closeSearch() {
    searching = false;
    dispatch('searchclose');
  }
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
    supportsDirectoryPicker, storedDirectory, hasAccess, ensureAccess,
    indexedChecksums, scanDirectory
  } from '$lib/roms/local-library';
  import { readAndKeep } from '$lib/roms/provider';
  import { keptFilesAvailable, indexedDbKeptFiles } from '$lib/roms/kept-files';
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
   * Recomputed whenever the library changes rather than inside the click
   * handler, so a press that has nothing to do reaches the session without
   * waiting on a disk. Not because the activation would expire - that claim
   * was mine and it is measured false, see `spendPressOnFolder` - but because
   * a button that pauses before doing anything reads as a broken button.
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
  let preparing = false;
  $: void refreshPrepareNeed(wanted);
  async function refreshPrepareNeed(list: string[]): Promise<void> {
    if (prepareTried) return;
    needsPrepare = list.length > 0 && (await missingFromDevice(list, PREPARE)).length > 0;
    void prepareAhead();
  }

  /**
   * Transfers the games before anybody presses anything.
   *
   * The reason the second press was miserable: the player pressed, waited
   * through a transfer, and was then told to press again. None of that
   * transfer needed their gesture - it needs the folder PERMISSION, which is
   * already granted and needs no click - so it can happen while the page sits
   * there, and the press that follows walks straight into the session.
   *
   * Only when the folder needs no dialog. If it does, the press has to buy
   * that first, and nothing here may touch the disk before then.
   */
  async function prepareAhead(): Promise<void> {
    if (!doorChecked || needsGrant || !needsPrepare || prepareTried || preparing) return;
    preparing = true;
    try {
      await bringGamesOntoTheDevice();
    } finally {
      preparing = false;
    }
  }

  /**
   * Whether the next press has to buy the folder permission first.
   *
   * Asked here rather than inside the handler so the common path stays
   * synchronous - see `folderNeedsGrant`.
   */
  let needsGrant = false;

  /** Until the folder has been asked about, nothing may read it. */
  let doorChecked = false;

  onMount(async () => {
    headsetHere = await vrAvailable();
    needsGrant = await folderNeedsGrant(DOOR);
    doorChecked = true;
    void prepareAhead();
  });

  /**
   * Straight through whenever there is nothing to do, which is the usual case
   * once the games have been transferred: no disk is touched and the session
   * opens on this press. The work only happens when there is work.
   */
  function enterVr(): void {
    if (!needsGrant && !needsPrepare) {
      requestVr();
      return;
    }
    void spendPressOnFolder();
  }

  async function spendPressOnFolder(): Promise<void> {
    if (needsGrant) {
      const outcome = await grantFolder(DOOR);
      if (outcome === 'refused') {
        needsGrant = true;
        notifications.show(t($language, 'vrFolderRefused'), 'error', 5000);
        return;
      }
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

    /*
     * Open the session on this press. Measured on a Quest 3, not assumed.
     *
     * The received wisdom - mine - was that `requestSession` needs fresh
     * transient activation, and that a native permission dialog or seconds of
     * reading the folder spends what this press carried. That was the entire
     * justification for making the player press twice, and it was never
     * checked on this browser. It is wrong: the session opens here after both.
     *
     * So do not reintroduce a second press on that reasoning. If some future
     * headset does refuse, `VrShell` reports it and pressing again works,
     * because `needsPrepare` is false by then and the button enters directly.
     */
    requestVr();
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

<svelte:window on:keydown={(e) => { if (e.key === 'Escape' && searching) closeSearch(); }} />

<header class="top-bar" class:searching>
  <div class="left">
    <!--
      The brand still goes home, because it always has and people who know that
      convention keep using it. It is no longer the only thing that does.
    -->
    <!--
      La vraie marque, et non une manette générique.
      
      C'était 🎮 + « PSNES » : un emoji qui n'est pas le logo de
      l'application, et dont le rendu dépend de la police du système. La
      La marque de `static/favicon.svg`, et non la cartouche entière de
      `icon.svg` : ce fichier porte lui-même la règle - « below 48px the
      shell cannot be both honest and legible » - et une barre fait 26 px.
      Essayé avec la coque d'abord, illisible, exactement comme annoncé.

      Le mot disparaît avec l'emoji : une marque qui se voit n'a pas besoin
      d'être aussi épelée à côté.
    -->
    <a class="brand" class:redundant={!!back} href="/" aria-label="psnes">
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
        <rect width="32" height="32" rx="5" fill="var(--brand)" />
        <path d="M10 6H22V18H14V26H10ZM14 10H18V14H14Z" fill="var(--label)" fill-rule="evenodd" />
      </svg>
    </a>

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

  <!--
    Ce que la page en cours veut porter dans la barre.
    
    La bibliothèque y met sa recherche : la barre est `sticky`, donc le champ
    reste atteignable pendant tout le défilement, alors que dans l'en-tête il
    disparaît dès la deuxième rangée. Un slot plutôt qu'un champ en dur,
    parce qu'un « chercher dans tes jeux » sur la page de profil ou la
    documentation serait du décor mort.
  -->
  <div class="page-tool">
    <slot name="tool" />
  </div>

  {#if $$slots.tool}
    <!-- Rendus seulement si la page a mis quelque chose à replier : sur
         /profile et /docs il n'y a pas de recherche, donc pas de loupe.
         Le CSS les cache au-dessus du point de rupture ; ils n'existent
         que pour l'écran étroit. -->
    <button class="icon-button search-toggle" on:click={openSearch} title={t($language, 'searchLibrary')} aria-label={t($language, 'searchLibrary')}>
      <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5L14 14" />
      </svg>
    </button>
    <button class="icon-button search-close" on:click={closeSearch} title={t($language, 'close')} aria-label={t($language, 'close')}>
      <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M4 4L12 12M12 4L4 12" />
      </svg>
    </button>
  {/if}

  <div class="right">
    {#if headsetHere}
      <!-- Capability, never a user agent: this button appears on a Quest and
           on a PC with a headset plugged in, and the "two controllers and
           nothing else" assumption only has to hold inside the session. -->
      <button
        class="bar-button vr"
        title={t($language, 'vrSeatedTitle')}
        aria-label={t($language, 'enterVr')}
        on:click={enterVr}
      >
        <!-- Un cardboard dessiné, pas un emoji : sur une machine sans police
             emoji un 🥽 rend un tofu, ce qui est arrivé ici. Deux oculaires
             dans un boîtier, ce qui est ce qu'on reconnaît d'un casque à
             cette taille. -->
        <svg class="vr-glyph" viewBox="0 0 24 16" width="24" height="16" aria-hidden="true">
          <rect x="0.9" y="1.9" width="22.2" height="12.2" rx="3.5"
                fill="none" stroke="currentColor" stroke-width="1.8" />
          <circle cx="7.4" cy="8" r="2.6" fill="currentColor" />
          <circle cx="16.6" cy="8" r="2.6" fill="currentColor" />
          <path d="M12 10.6c-0.7 0-1.1-0.5-1.1-1.3s0.4-1.3 1.1-1.3 1.1 0.5 1.1 1.3-0.4 1.3-1.1 1.3z"
                fill="currentColor" />
        </svg>
        <span class="vr-label">{t($language, 'enterVr')}</span>
      </button>
      <!-- Beside the button, not under it: this bar is a centred flex row and a
           second line would change its height on every page. Only rendered
           where the button is, so a PC with no headset never sees it. -->
      <span class="vr-hint">{t($language, 'vrSeatedHint')}</span>
    {/if}

    <button
      class="bar-button friends"
      class:on={showFriends}
      title={t($language, 'friends')}
      aria-label={t($language, 'friends')}
      on:click={toggleFriends}
    >
      <!-- Deux silhouettes, dessinées : c'est ce qu'on reconnaît d'une liste
           d'amis à 17 px, et ça ne dépend d'aucune police installée. -->
      <svg class="friends-glyph" viewBox="0 0 20 16" width="20" height="16"
           fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"
           aria-hidden="true">
        <circle cx="7.5" cy="5" r="3" />
        <path d="M1.8 14c0-2.8 2.5-4.6 5.7-4.6s5.7 1.8 5.7 4.6" />
        <path d="M14 3.2a3 3 0 0 1 0 5.6M15.6 9.8c1.7.6 2.8 2 2.8 4" />
      </svg>
      <span class="friends-label">{t($language, 'friends')}</span>
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
  .page-tool {
    /* Ne prend de la place que si la page en met quelque chose. */
    display: contents;
  }

  /* La loupe et la croix n'existent que sur écran étroit : au-dessus du
     point de rupture la recherche est dans la barre en permanence, et une
     loupe qui l'ouvrirait n'ouvrirait rien. */
  .icon-button {
    display: none;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 0.25rem 0.55rem;
    background: var(--ground);
    border: var(--btn-border) solid var(--edge);
    box-shadow: var(--btn-bevel);
    color: var(--shell);
    border-radius: var(--btn-radius);
    cursor: pointer;
  }

  .vr-glyph {
    display: none;
  }

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
    background: var(--panel);
    /* Trois pixels d'or, pas un liseré gris : c'est ce trait qui fait lire
       le bandeau comme une barre d'état plutôt que comme un en-tête. */
    border-bottom: 3px solid var(--edge);
  }

  .left {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
    /* La cible reste confortable alors que la marque a rétréci. */
    padding: 0.25rem;
  }

  .brand:focus-visible {
    outline: 2px solid var(--brand-lift);
    outline-offset: 2px;
  }

  .right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  /* La touche du HUD : sombre, cerclée d'or, moulée.
     Les valeurs de forme viennent des jetons et non d'une copie de la
     recette - c'est cette copie, et sa dérive, qui faisait lire « Amis »
     et « Rescanner le dossier » comme deux objets différents. La règle est
     ici plutôt que dans le plancher parce qu'elle habille aussi des <a>,
     que `:global(button)` n'atteint pas ; ce qu'elle ajoute à la forme
     commune est sa couleur, et rien d'autre. */
  .bar-button {
    display: inline-flex;
    align-items: center;
    background: var(--ground);
    border: var(--btn-border) solid var(--edge);
    box-shadow: var(--btn-bevel);
    color: var(--shell);
    font-family: var(--display);
    font-size: var(--btn-size);
    padding: var(--btn-pad);
    border-radius: var(--btn-radius);
    cursor: pointer;
  }

  .bar-button:hover {
    background: var(--panel);
    color: var(--label);
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

  /*
   * Enfoncée, et non allumée.
   *
   * Cet état avait d'abord été peint en vert. C'était une faute de
   * vocabulaire : dans cette palette le vert veut dire « on avance », et
   * un tiroir ouvert n'est pas une action en cours - c'est un état. Le
   * dépenser là aurait rendu le vert muet ailleurs.
   *
   * Une touche moulée dit son état par son relief : le biseau s'inverse,
   * sombre en haut et clair en bas, et le bouton s'enfonce d'un pixel.
   * Seul, c'était juste mais trop discret à cette taille - d'où le libellé
   * qui passe à l'or. L'or est l'accent du HUD, pas un verbe : il ne dit
   * ni « avance » ni « annule », donc l'emprunter pour dire « ouvert » ne
   * coûte rien au vert ni au rouge.
   */
  .bar-button.on {
    box-shadow: inset 0 4px 0 rgba(0, 0, 0, 0.4), inset 0 -4px 0 rgba(255, 255, 255, 0.08);
    color: var(--edge);
    transform: translateY(1px);
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

  .friends-glyph {
    display: none;
  }

  .avatar {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    overflow: hidden;
    background: var(--ground);
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
  /*
   * L'écran étroit, et le nombre vient d'une mesure : le contenu de cette
   * barre fait 393 px, donc à 390 la page défile latéralement et la marque
   * est rognée en un trait. 480 couvre ça, et c'est le point de rupture que
   * ce fichier utilisait déjà - un troisième nombre n'apprendrait rien.
   *
   * La marque part en entier, et non plus seulement quand un retour la
   * double : c'est le seul élément de la barre qui ne fasse rien qu'un
   * autre ne fasse déjà.
   */
  @media (max-width: 480px) {
    .brand {
      display: none;
    }

    /* Le VR garde son icône et perd son mot. */
    .vr-label {
      display: none;
    }

    .vr-glyph {
      display: block;
    }

    .page-tool {
      display: none;
    }

    .search-toggle {
      display: inline-flex;
    }

    /* Amis passe à son icône, comme le VR. Le retour, lui, garde ses mots :
       ce fichier porte la conclusion qu'un retour qu'il faut deviner n'en
       est pas un, et la flèche y est une décoration à côté du mot, pas un
       substitut. La place se prend donc ailleurs. */
    .friends-label {
      display: none;
    }

    .friends-glyph {
      display: block;
    }

    /* Et sur le peu qui reste : la barre se resserre. Mesuré à 416 px de
       contenu pour 390 de large sur /profile, où il n'y a rien à replier. */
    .top-bar {
      gap: 0.5rem;
      padding: 0.5rem 0.6rem;
    }

    .bar-button {
      padding: 0.25rem 0.55rem;
    }

    /* Dépliée, la recherche prend la barre : il n'y a pas de place pour
       elle ET pour le reste, et la rétrécir jusqu'à ce que tout tienne la
       rendrait inutilisable pour tout le monde. */
    .top-bar.searching .page-tool {
      display: contents;
    }

    .top-bar.searching .left,
    .top-bar.searching .right,
    .top-bar.searching .search-toggle {
      display: none;
    }

    .top-bar.searching .search-close {
      display: inline-flex;
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
