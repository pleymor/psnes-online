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
   */
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { socket, waitForSocket } from '$lib/api/socket';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import FriendsList from './FriendsList.svelte';
  import FriendDetailsModal from './FriendDetailsModal.svelte';

  export let activeRooms: any[] = [];

  let showFriends = false;
  let friendsListRef: FriendsList;
  let selectedFriend: any = null;

  /** What the server tells a client about an invitation addressed to it. */
  interface Invitation {
    id: string;
    roomId: string;
    fromUserId: string;
    fromPseudo: string;
    fromAvatar?: string;
    /** Absent while the room has no game yet, which is now an ordinary state. */
    gameTitle?: string;
    /**
     * An ISO string, not a Date: Socket.IO serialises dates on the way out and
     * never revives them, so this has to be parsed before it means anything.
     */
    expiresAt: string;
  }

  let invitations: Invitation[] = [];
  let showInvitations = false;
  let invitationError = '';
  /** The invitation whose answer is in flight, so a refusal can be attributed. */
  let answering: string | null = null;
  let now = Date.now();
  let clock: ReturnType<typeof setInterval> | undefined;
  /**
   * Whether this bar is still mounted.
   *
   * The listeners below go on after an await while `onDestroy` runs
   * synchronously, so a cold load of `/` that the player clicks away from
   * before `/auth/me` resolves destroys this component inside that window.
   * Five handlers would then be left on the shared socket with no `off` ever
   * coming for them - one of which calls `goto`.
   */
  let alive = true;

  /**
   * The invitations still standing at this instant.
   *
   * The server filters expired ones when it hands them over, but a tray left
   * open outlives that answer: without a clock of its own this panel would go on
   * offering an invitation the server will now refuse. Ten minutes is short
   * enough for that to happen while someone reads their library.
   */
  $: liveInvitations = invitations.filter(i => new Date(i.expiresAt).getTime() > now);
  // The drawer and its button both vanish with the last invitation, so leaving
  // the flag set would make the next one arrive with the panel already open.
  $: if (liveInvitations.length === 0) showInvitations = false;

  /**
   * `at` and `lang` are arguments rather than reads of `now` and `$language`,
   * so the template tracks them: an expression whose dependencies are only
   * hidden inside a function body never re-runs when they change, and this one
   * has to tick.
   */
  function expiryLabel(invitation: Invitation, at: number, lang: 'en' | 'fr'): string {
    const minutes = Math.ceil((new Date(invitation.expiresAt).getTime() - at) / 60_000);
    return minutes <= 1
      ? t(lang, 'expiresInAMinute')
      : t(lang, 'expiresInMinutes', { count: minutes });
  }

  function handleInvitations(list: Invitation[]) {
    // Replaced, not merged: this is the server's whole answer - sent at every
    // connection, already filtered for expiry and for rooms that still exist -
    // and merging would keep resurrecting the ones it left out on purpose.
    invitations = list ?? [];
  }

  function handleInvitation(invitation: Invitation) {
    // Keyed by id rather than appended: re-inviting refreshes one row instead of
    // adding another, so the same id arrives again with a later deadline.
    invitations = [...invitations.filter(i => i.id !== invitation.id), invitation];
  }

  function handleAccepted({ invitationId, roomId }: { invitationId: string; roomId: string }) {
    forget(invitationId);
    showInvitations = false;
    // `from=invitation` so the room screen can say so if it lands in a match
    // that is already running: `lobby:accept` does not look at the room's
    // status, and being seated into a game in progress is not an ordinary
    // arrival even though the seat is legitimately theirs.
    goto(`/room/${roomId}?from=invitation`);
  }

  function handleDeclined({ invitationId }: { invitationId: string }) {
    forget(invitationId);
  }

  /**
   * The room took its invitation back.
   *
   * It leaves the tray without a word: the invitee never asked for anything, so
   * there is nothing to report to them - but leaving the row would offer an
   * invitation the server now refuses, and the only thing accepting it could
   * earn them is an error.
   */
  function handleCancelled({ invitationId }: { invitationId: string }) {
    forget(invitationId);
  }

  function forget(invitationId: string) {
    answering = null;
    invitationError = '';
    invitations = invitations.filter(i => i.id !== invitationId);
  }

  /**
   * Only while an answer of ours is in flight.
   *
   * `error` is the server's general-purpose channel, so a message meant for
   * some other feature has no business surfacing in the invitation tray. The
   * row is left in place: a room that filled up can free a seat again while the
   * ten minutes are still running, and the server leaves that invitation
   * pending for exactly that reason.
   */
  function handleError(payload: { message?: string }) {
    if (!answering) return;
    answering = null;
    invitationError = payload?.message ?? '';
  }

  function acceptInvitation(invitation: Invitation) {
    invitationError = '';
    answering = invitation.id;
    $socket?.emit('lobby:accept', { invitationId: invitation.id });
  }

  function declineInvitation(invitation: Invitation) {
    invitationError = '';
    answering = invitation.id;
    $socket?.emit('lobby:decline', { invitationId: invitation.id });
  }

  onMount(async () => {
    clock = setInterval(() => (now = Date.now()), 15_000);

    // Not `$socket?.on(...)`: this bar mounts with the page, and a child's
    // onMount runs before its parent's - so the layout has not created the
    // socket yet and the invitations the server pushes at connection time
    // would land on nobody.
    const sock = await waitForSocket();
    if (!sock || !alive) return;

    sock.on('lobby:invitations', handleInvitations);
    sock.on('lobby:invitation', handleInvitation);
    sock.on('lobby:accepted', handleAccepted);
    sock.on('lobby:declined', handleDeclined);
    sock.on('lobby:invitation-cancelled', handleCancelled);
    sock.on('error', handleError);
  });

  onDestroy(() => {
    alive = false;
    clearInterval(clock);
    if (!$socket) return;
    $socket.off('lobby:invitations', handleInvitations);
    $socket.off('lobby:invitation', handleInvitation);
    $socket.off('lobby:accepted', handleAccepted);
    $socket.off('lobby:declined', handleDeclined);
    $socket.off('lobby:invitation-cancelled', handleCancelled);
    $socket.off('error', handleError);
  });

  function toggleFriends() {
    showFriends = !showFriends;
    // One drawer at a time: both are fixed to the same corner.
    if (showFriends) showInvitations = false;
  }

  function toggleInvitations() {
    showInvitations = !showInvitations;
    if (showInvitations) showFriends = false;
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
    <!-- Shown only when there is something to answer: a permanently visible
         empty tray is a button that never does anything. -->
    {#if liveInvitations.length > 0}
      <button class="bar-button" class:on={showInvitations} on:click={toggleInvitations}>
        {t($language, 'invitations')}
        <span class="badge">{liveInvitations.length}</span>
      </button>
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

{#if showInvitations && liveInvitations.length > 0}
  <!-- Same drawer geometry as the friends list, including the narrow-screen
       takeover, because it is the same kind of panel in the same corner. -->
  <div class="friends-drawer">
    <div class="invites-panel">
      <h2>{t($language, 'invitations')}</h2>

      {#if invitationError}
        <p class="invite-error">{invitationError}</p>
      {/if}

      {#each liveInvitations as invitation (invitation.id)}
        <div class="invite">
          <div class="invite-avatar">
            {#if invitation.fromAvatar}
              <img src={invitation.fromAvatar} alt="" />
            {:else}
              👤
            {/if}
          </div>
          <div class="invite-info">
            <strong>{t($language, 'invitedYou', { name: invitation.fromPseudo })}</strong>
            <!-- A room can be waiting with no game at all now, so there is
                 nothing to name - say that rather than show an empty line. -->
            <small>{invitation.gameTitle ?? t($language, 'noGameChosen')}</small>
            <small class="invite-expiry">{expiryLabel(invitation, now, $language)}</small>
          </div>
          <div class="invite-actions">
            <button
              class="btn-accept"
              disabled={answering === invitation.id}
              on:click={() => acceptInvitation(invitation)}
            >
              {t($language, 'accept')}
            </button>
            <button
              class="btn-decline"
              disabled={answering === invitation.id}
              on:click={() => declineInvitation(invitation)}
            >
              {t($language, 'decline')}
            </button>
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

{#if showFriends}
  <!-- A dropdown on a wide screen, the whole screen on a narrow one: a friends
       list in a narrow column is not readable, which is the same reason the
       pause panel makes the same split.

       The full layout, not the compact one: compact is a strip of avatars with
       no way to add a friend and no way to accept a request, and the bar is now
       the only place either is reachable from. The drawer is 24rem wide, which
       is what the full layout was built for in the sidebar. -->
  <div class="friends-drawer">
    <FriendsList bind:this={friendsListRef} {activeRooms} on:friendClicked={handleFriendClicked} />
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

  .badge {
    display: inline-block;
    margin-left: 0.4rem;
    min-width: 1.2rem;
    padding: 0 0.3rem;
    border-radius: 999px;
    background: #667eea;
    color: #fff;
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1.2rem;
    text-align: center;
  }

  .invites-panel {
    padding: 1.5rem;
  }

  .invites-panel h2 {
    margin: 0 0 1rem;
    font-size: 1.1rem;
  }

  .invite {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.6rem 0;
    border-top: 1px solid #2e2e2e;
  }

  .invite-avatar {
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    overflow: hidden;
    background: #333;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .invite-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .invite-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1;
  }

  .invite-info strong {
    font-size: 0.95rem;
  }

  .invite-info small {
    color: #8b8ba3;
    font-size: 0.8rem;
  }

  .invite-expiry {
    font-variant-numeric: tabular-nums;
  }

  .invite-actions {
    display: flex;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .btn-accept,
  .btn-decline {
    border: none;
    border-radius: 6px;
    padding: 0.35rem 0.7rem;
    font-size: 0.85rem;
    cursor: pointer;
    color: #fff;
  }

  .btn-accept {
    background: #4caf50;
  }

  .btn-decline {
    background: #3a3a3a;
  }

  .btn-accept:disabled,
  .btn-decline:disabled {
    opacity: 0.5;
    cursor: progress;
  }

  .invite-error {
    margin: 0 0 0.75rem;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    background: rgba(244, 67, 54, 0.12);
    border: 1px solid rgba(244, 67, 54, 0.4);
    color: #f08a80;
    font-size: 0.85rem;
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
