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
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import FriendsList from './FriendsList.svelte';
  import FriendDetailsModal from './FriendDetailsModal.svelte';
  import { activeRooms } from '$lib/rooms/my-room';

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
  <a class="brand" href="/">🎮 PSNES</a>

  <div class="right">
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

  .bar-button.on {
    background: #3a4a5a;
    border-color: #667eea;
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
