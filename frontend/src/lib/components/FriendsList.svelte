<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import { parseHandle } from '$lib/pseudo';
  import { myRoom } from '$lib/rooms/my-room';
  import { inviteToGroup, cancelGroupInvitation } from '$lib/rooms/actions';

  export let compact = false; // Compact mode for small screens
  export let activeRooms: any[] = []; // List of active rooms from API

  const dispatch = createEventDispatcher();
  const logger = createLogger('FriendsList');

  let friends: any[] = [];
  let friendRequests: any[] = [];
  let showAddFriend = false;
  /** A pasted `Sprite#0417`. There is no longer any way to browse for one. */
  let handleInput = '';
  let isSending = false;
  let errorMessage = '';
  let successMessage = '';
  let friendRooms = new Map<string, any>(); // userId -> room
  let onlineFriends = new Map<string, boolean>(); // userId -> online status
  let selectedFriend: any = null;

  /**
   * A friend's room, as it is now rather than as it was created.
   *
   * `friend:roomCreated` fires exactly once, at `room:create`. Everything that
   * happens to the room afterwards - and choosing the game is now something
   * that happens afterwards - travels on `room:update`, which the host's
   * friends already receive and which nothing outside the room screen listened
   * to. Without this, a friend who created an empty lobby and then picked a
   * game stayed « in a room » for the rest of the session, with a Join button
   * and no way to learn what the game was. Reopening the drawer did not help:
   * the block below refills from the page's copy, fetched once.
   *
   * Keyed by `createdBy` like every other writer here, so the three sources
   * agree on which friend a room belongs to.
   */
  function handleRoomUpdate(room: any) {
    const creatorId = room?.createdBy || room?.hostId;
    if (!creatorId) return;
    friendRooms.set(creatorId, room);
    friendRooms = friendRooms; // Trigger reactivity
  }

  // Reactive statement to merge API rooms with WebSocket rooms
  $: {
    // Update friendRooms with rooms from API (indexed by creator, not current host)
    if (activeRooms && activeRooms.length > 0) {
      activeRooms.forEach(room => {
        // Use createdBy to track original creator, fallback to hostId for compatibility
        const creatorId = room.createdBy || room.hostId;
        if (creatorId) {
          friendRooms.set(creatorId, room);
        }
      });
      friendRooms = friendRooms; // Trigger reactivity
    }
  }

  onMount(async () => {
    // Load friends
    const res = await fetch('/api/friends', { credentials: 'include' });
    if (res.ok) {
      friends = await res.json();
    }

    // Load pending requests
    const reqRes = await fetch('/api/friends/requests', { credentials: 'include' });
    if (reqRes.ok) {
      friendRequests = await reqRes.json();
    }

    // Listen for initial online status
    $socket?.on('friends:online', (friendsWithStatus: any[]) => {
      // Initialize online status map
      onlineFriends = new Map(friendsWithStatus.map(f => [f.id, f.online]));
      onlineFriends = onlineFriends; // Trigger reactivity
    });

    // Listen for friend status changes (online/offline)
    $socket?.on('friend:statusChanged', ({ userId, online }: any) => {
      onlineFriends.set(userId, online);
      onlineFriends = onlineFriends; // Trigger reactivity
    });

    // Request initial online status (after listeners are set up)
    $socket?.emit('friends:getOnlineStatus');

    $socket?.on('friend:roomCreated', ({ userId, room }: any) => {
      // Store the room for this friend
      friendRooms.set(userId, room);
      friendRooms = friendRooms; // Trigger reactivity
    });

    $socket?.on('room:update', handleRoomUpdate);

    $socket?.on('friend:roomStatusChanged', ({ userId, roomId, status }: any) => {
      if (status === 'destroyed') {
        // Remove the room for this friend
        friendRooms.delete(userId);
        friendRooms = friendRooms; // Trigger reactivity
      } else if (status === 'playing') {
        // Update room status
        const room = friendRooms.get(userId);
        if (room && room.id === roomId) {
          room.status = 'playing';
          friendRooms = friendRooms; // Trigger reactivity
        }
      }
    });

    // Listen for new friend requests
    $socket?.on('friend:requestReceived', (friendship: any) => {
      friendRequests = [...friendRequests, friendship];
    });

    // Listen for accepted friend requests
    $socket?.on('friend:requestAccepted', (friendship: any) => {
      // Remove from requests list
      friendRequests = friendRequests.filter(r => r.id !== friendship.id);

      // Add to friends list (determine which user to add)
      const newFriend = friendship.initiatorId !== friendship.receiverId
        ? (friendship.initiator.id === $user?.id ? friendship.receiver : friendship.initiator)
        : null;

      if (newFriend && !friends.some(f => f.friend.id === newFriend.id)) {
        friends = [...friends, {
          friendshipId: friendship.id,
          friend: newFriend,
          friendsSince: friendship.updatedAt,
          createdAt: friendship.createdAt
        }];
      }
    });

    // Listen for rejected/deleted friend requests
    $socket?.on('friend:requestRejected', ({ friendshipId }: any) => {
      friendRequests = friendRequests.filter(r => r.id !== friendshipId);
    });

    // Listen for removed friends
    $socket?.on('friend:removed', ({ friendshipId }: any) => {
      friends = friends.filter(f => f.friendshipId !== friendshipId);
      // Close modal if the removed friend was selected
      if (selectedFriend?.friendshipId === friendshipId) {
        selectedFriend = null;
      }
    });
  });

  onDestroy(() => {
    // Clean up event listeners
    $socket?.off('friends:online');
    $socket?.off('friend:statusChanged');
    $socket?.off('friend:requestReceived');
    $socket?.off('friend:requestAccepted');
    $socket?.off('friend:requestRejected');
    $socket?.off('friend:removed');
    $socket?.off('friend:roomCreated');
    $socket?.off('friend:roomStatusChanged');
    // Named, unlike its neighbours: `room:update` is the one event here that
    // another screen also listens to, and a bare off() would take its listener
    // down too.
    $socket?.off('room:update', handleRoomUpdate);
  });

  /**
   * There is no lookup of any kind before this call.
   *
   * The user search this component used to carry queried every account by
   * email or name on two typed characters. A handle is the only way in now,
   * and the server is the only thing that knows whether one exists - so this
   * checks the shape and lets the API answer the rest.
   */
  $: handleMalformed = handleInput.trim().length > 0 && !parseHandle(handleInput);

  async function sendFriendRequest() {
    const parsed = parseHandle(handleInput);
    if (!parsed || isSending) return;

    isSending = true;
    errorMessage = '';
    successMessage = '';

    try {
      const res = await fetch('/api/friends/request', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: handleInput.trim() })
      });

      if (res.ok) {
        successMessage = t($language, 'friendRequestSent');
        handleInput = '';
        setTimeout(() => {
          successMessage = '';
          showAddFriend = false;
        }, 2000);
        return;
      }

      const error = await res.json().catch(() => ({}));
      errorMessage = error.error === 'HANDLE_NOT_FOUND'
        ? t($language, 'handleNotFound')
        : error.error === 'HANDLE_MALFORMED'
        ? t($language, 'handleMalformed')
        : error.error === 'TOO_MANY_ATTEMPTS'
        ? t($language, 'tooManyAttempts')
        : error.error === 'Friendship already exists'
        ? t($language, 'alreadyFriends')
        : error.error === 'Cannot add yourself as friend'
        ? t($language, 'cannotAddYourself')
        : t($language, 'failedToSendRequest');
    } catch (err) {
      logger.error('Could not send a friend request', err);
      errorMessage = t($language, 'failedToSendRequest');
    } finally {
      isSending = false;
    }
  }

  async function acceptRequest(friendshipId: string) {
    const res = await fetch(`/api/friends/accept/${friendshipId}`, {
      method: 'POST',
      credentials: 'include'
    });

    if (res.ok) {
      const updatedFriendship = await res.json();

      // Remove from requests list
      friendRequests = friendRequests.filter(r => r.id !== friendshipId);

      // Add to friends list
      const newFriend = updatedFriendship.initiatorId === $user?.id
        ? updatedFriendship.receiver
        : updatedFriendship.initiator;

      if (!friends.some(f => f.friend.id === newFriend.id)) {
        friends = [...friends, {
          friendshipId: updatedFriendship.id,
          friend: newFriend,
          friendsSince: updatedFriendship.updatedAt,
          createdAt: updatedFriendship.createdAt
        }];
      }
    }
  }

  async function rejectRequest(friendshipId: string) {
    await fetch(`/api/friends/${friendshipId}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    friendRequests = friendRequests.filter(r => r.id !== friendshipId);
  }

  function openFriendDetails(friendData: any) {
    dispatch('friendClicked', friendData);
  }

  /*
   * Whether this friend can be asked to play, and what to show instead.
   *
   * Read from my own room rather than from a local flag: the invitation lives on
   * the room's public view, so it survives a reload, it is the same fact both
   * members see, and cancelling it from anywhere makes this row change back on
   * its own.
   *
   * `groupFull` counts members, not the players present: an away member's seat is
   * still theirs, and inviting somebody else would be refused.
   */
  $: groupFull = ($myRoom?.players.length ?? 0) >= 2;
  $: groupBusy = $myRoom?.status === 'playing';
  $: invitedId = $myRoom?.invitation?.toUserId ?? null;
  /*
   * A set, and a `$:` value rather than a function.
   *
   * A function declaration called from the markup does not make `$myRoom` a
   * dependency of the expression that calls it: Svelte tracks the names in the
   * expression, not what the body reads. So the row would settle on whatever it
   * showed the first time and never learn that the friend had joined - which is
   * exactly what it did, showing no tag at all once the invitation was accepted.
   */
  $: groupMemberIds = new Set(($myRoom?.players ?? []).map((p) => p.userId));

  export async function removeFriend(friendshipId: string) {
    const res = await fetch(`/api/friends/${friendshipId}`, {
      method: 'DELETE',
      credentials: 'include'
    });

    if (res.ok) {
      // Remove from friends list
      friends = friends.filter(f => f.friendshipId !== friendshipId);
    }
  }
</script>

<div class="friends-panel" class:compact>
  {#if !compact}
    <!-- Full view -->
    <div class="header">
      <h2>{t($language, 'friends')}</h2>
      <button on:click={() => showAddFriend = !showAddFriend} class="btn-add">
        +
      </button>
    </div>

    {#if showAddFriend}
      <div class="add-friend">
        <form class="handle-form" on:submit|preventDefault={sendFriendRequest}>
          <input
            type="text"
            bind:value={handleInput}
            autocomplete="off"
            spellcheck="false"
            placeholder={t($language, 'handlePlaceholder')}
            aria-invalid={handleMalformed}
            class="handle-input"
            class:bad={handleMalformed}
          />
          <button type="submit" disabled={!parseHandle(handleInput) || isSending}>
            {t($language, 'add')}
          </button>
        </form>
        <p class="hint">{t($language, 'handleHint')}</p>

        {#if errorMessage}
          <div class="message error-message">{errorMessage}</div>
        {/if}

        {#if successMessage}
          <div class="message success-message">{successMessage}</div>
        {/if}
      </div>
    {/if}

    {#if friendRequests.length > 0}
      <div class="section">
        <h3>{t($language, 'requests')}</h3>
        {#each friendRequests as request}
          <div class="request">
            <div class="info">
              <strong>{request.initiator.pseudo}</strong>
            </div>
            <div class="actions">
              <button on:click={() => acceptRequest(request.id)} class="btn-accept">✓</button>
              <button on:click={() => rejectRequest(request.id)} class="btn-reject">✗</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <div class="friends-list">
      {#if friends.length === 0}
        <p class="empty">{t($language, 'noFriendsYet')}</p>
      {:else}
        {#each friends as friendData}
          {@const room = friendRooms.get(friendData.friend.id)}
          <div class="friend">
            <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
            <div class="friend-main" on:click={() => openFriendDetails(friendData)}>
              <div class="avatar">
                {#if friendData.friend.avatar}
                  <img src={friendData.friend.avatar} alt={friendData.friend.pseudo} />
                {:else}
                  👤
                {/if}
              </div>
              <div class="info">
                <strong>{friendData.friend.pseudo}</strong>
                {#if room}
                  <!-- A room can be waiting with no game chosen yet, and a blank
                       line there says nothing at all - so name the state
                       instead of the game. -->
                  <small class="room-status">{room.gameTitle ?? t($language, 'inLobby')}</small>
                {:else if onlineFriends.get(friendData.friend.id)}
                  <small class="online-status">{t($language, 'online')}</small>
                {:else}
                  <small class="offline-status">{t($language, 'offline')}</small>
                {/if}
              </div>
            </div>
            <!-- Outside `.friend-main`, and with `stopPropagation`: that block
                 opens the details modal on click, and an invite button inside it
                 would open the modal too. -->
            {#if groupMemberIds.has(friendData.friend.id)}
              <span class="friend-tag">{t($language, 'inYourGroup')}</span>
            {:else if invitedId === friendData.friend.id}
              <button
                class="btn-invite-friend cancel"
                on:click|stopPropagation={() => cancelGroupInvitation($myRoom?.invitation?.id ?? '')}
              >
                {t($language, 'invitedWaiting')} ✕
              </button>
            {:else if !groupFull && !groupBusy && !invitedId}
              <button
                class="btn-invite-friend"
                on:click|stopPropagation={() => inviteToGroup(friendData.friend.id)}
              >
                {t($language, 'invite')}
              </button>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {:else}
    <!-- Compact view: just avatars with status badges -->
    <div class="compact-friends">
      {#if friendRequests.length > 0}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div class="compact-badge-container" role="button" tabindex="0" title="{friendRequests.length} friend request(s)">
          <div class="compact-avatar notification-badge">
            <span class="icon">👥</span>
            <div class="badge-dot requests">{friendRequests.length}</div>
          </div>
        </div>
      {/if}

      {#each friends as friendData}
        {@const room = friendRooms.get(friendData.friend.id)}
        {@const isOnline = onlineFriends.get(friendData.friend.id)}
        {@const isPlaying = room !== undefined}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div
          class="compact-badge-container"
          role="button"
          tabindex="0"
          on:click={() => openFriendDetails(friendData)}
          title={friendData.friend.pseudo}
        >
          <div class="compact-avatar">
            {#if friendData.friend.avatar}
              <img src={friendData.friend.avatar} alt={friendData.friend.pseudo} />
            {:else}
              <span class="icon">👤</span>
            {/if}
            {#if isPlaying}
              <div class="badge-dot in-room"></div>
            {:else if isOnline}
              <div class="badge-dot online"></div>
            {:else}
              <div class="badge-dot offline"></div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .friends-panel {
    background: transparent;
    border-radius: 0;
    padding: 1.5rem;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  h2 {
    margin: 0;
    font-size: 1.25rem;
  }

  .btn-add {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    cursor: pointer;
    font-size: 1.25rem;
  }

  .add-friend {
    margin-bottom: 1rem;
  }

  .handle-form {
    display: flex;
    gap: 0.5rem;
  }

  .handle-input {
    flex: 1;
    min-width: 0;
    padding: 0.75rem;
    background: #1a1a1a;
    border: 2px solid #444;
    border-radius: 8px;
    color: white;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.875rem;
    transition: all 0.2s;
  }

  .handle-input:focus {
    outline: none;
    border-color: #667eea;
    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
  }

  .handle-input.bad {
    border-color: #b3564b;
  }

  .handle-form button {
    padding: 0 1rem;
    border: 0;
    border-radius: 8px;
    /* Pas le #667eea de la marque : 3.66:1 sous du blanc, sous les 4.5
       qu'AA demande. Même teinte, assombrie jusqu'à 4.96:1. */
    background: #4764e6;
    color: white;
    font-size: 0.875rem;
    cursor: pointer;
  }

  .handle-form button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .hint {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    color: #888;
  }

  .message {
    margin-top: 0.75rem;
    padding: 0.75rem;
    border-radius: 6px;
    font-size: 0.875rem;
    animation: slideIn 0.3s ease-out;
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .error-message {
    background: rgba(244, 67, 54, 0.1);
    border: 1px solid #f44336;
    color: #f44336;
  }

  .success-message {
    background: rgba(76, 175, 80, 0.1);
    border: 1px solid #4caf50;
    color: #4caf50;
  }

  .section {
    margin-bottom: 1rem;
  }

  h3 {
    font-size: 0.875rem;
    color: #888;
    margin: 0 0 0.5rem 0;
  }

  .request {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background: #1a1a1a;
    border-radius: 6px;
    margin-bottom: 0.5rem;
  }

  .btn-accept {
    background: #4caf50;
    color: white;
    border: none;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
  }

  .btn-reject {
    background: #f44336;
    color: white;
    border: none;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
  }

  .friends-list {
    margin-top: 1rem;
  }

  .friend {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem;
    background: #1a1a1a;
    border-radius: 6px;
    margin-bottom: 0.5rem;
    transition: all 0.2s;
  }

  .friend:hover {
    background: #252525;
  }

  .friend-main {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    cursor: pointer;
    min-width: 0; /* Allow text truncation */
  }

  .btn-invite-friend {
    flex: 0 0 auto;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #fff;
    border: none;
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .btn-invite-friend.cancel {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .friend-tag {
    flex: 0 0 auto;
    font-size: 0.75rem;
    color: #9aa0b5;
  }

  .avatar {
    width: 40px;
    height: 40px;
    min-width: 40px; /* Prevent shrinking */
    min-height: 40px; /* Prevent shrinking */
    border-radius: 50%;
    background: #333;
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 1.5rem;
    overflow: hidden;
    flex-shrink: 0; /* Prevent avatar from shrinking */
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .info {
    min-width: 0; /* Allow text truncation */
    flex: 1;
  }

  .info strong {
    display: block;
    font-size: 0.875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .info small {
    color: #888;
    font-size: 0.75rem;
    display: block;
  }

  .info .room-status {
    color: #667eea;
    font-weight: 500;
  }

  .info .online-status {
    color: #4caf50;
    font-weight: 500;
  }

  .info .offline-status {
    color: #888;
  }

  .empty {
    text-align: center;
    color: #666;
    padding: 2rem 0;
  }

  /* Compact mode styles */
  .friends-panel.compact {
    padding: 0;
    background: transparent;
    border-radius: 0;
  }

  .compact-friends {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.5rem;
    align-items: center;
  }

  .compact-badge-container {
    position: relative;
    cursor: pointer;
    transition: transform 0.2s;
  }

  .compact-badge-container:hover {
    transform: scale(1.1);
  }

  .compact-avatar {
    position: relative;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #333;
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 1.5rem;
    overflow: hidden;
    border: 2px solid rgba(255, 255, 255, 0.1);
    transition: border-color 0.2s;
  }

  .compact-badge-container:hover .compact-avatar {
    border-color: rgba(102, 126, 234, 0.5);
  }

  .compact-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .compact-avatar .icon {
    font-size: 1.5rem;
  }

  .compact-avatar.notification-badge {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  }

  .badge-dot {
    position: absolute;
    bottom: 2px;
    right: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid #141414;
    box-shadow: 0 0 4px rgba(0, 0, 0, 0.3);
  }

  .badge-dot.online {
    background: #4caf50;
    box-shadow: 0 0 8px rgba(76, 175, 80, 0.6);
  }

  .badge-dot.offline {
    background: #666;
  }

  .badge-dot.in-room {
    background: #667eea;
    box-shadow: 0 0 8px rgba(102, 126, 234, 0.6);
  }

  .badge-dot.requests {
    width: 18px;
    height: 18px;
    background: #f44336;
    color: white;
    font-size: 0.65rem;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid #141414;
  }
</style>
