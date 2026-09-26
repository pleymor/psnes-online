<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import { parseHandle } from '$lib/pseudo';
  import { myRoom } from '$lib/rooms/my-room';
  import { friendRooms } from '$lib/rooms/friend-rooms';
  import { inviteToGroup, cancelGroupInvitation } from '$lib/rooms/actions';
  import { get } from 'svelte/store';
  import { controls, currentHomeMode } from '$lib/stores/home-mode';
  import { isOfflineMode } from '$lib/rooms/local-play';
  import { reasonKey } from '$lib/rooms/anonymous-join';
  import { readKnownFriends, rememberFriends } from '$lib/stores/known-friends';

  export let compact = false; // Compact mode for small screens

  /*
   * Hors-ligne, le tiroir est le même, éteint.
   *
   * La liste est celle de la dernière connexion (`stores/known-friends.ts`),
   * sans statut : sans socket personne n'est « en ligne ». Chaque bouton qui
   * demande le serveur - ajouter, accepter, refuser, inviter - reste à sa
   * place, éteint, et son infobulle dit pourquoi.
   */
  $: actionReason = reasonKey($controls.friendActions);
  $: actionsOff = actionReason !== null;
  $: actionTitle = actionReason ? t($language, actionReason) : undefined;
  $: offlineNote =
    $currentHomeMode.kind === 'local'
      ? t($language, 'noAccountFriendsNote')
      : $currentHomeMode.kind === 'offline-account'
        ? t($language, 'offlineFriendsNote')
        : '';

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
  let onlineFriends = new Map<string, boolean>(); // userId -> online status
  /**
   * Qui est dans le lobby VR.
   *
   * « En VR » est un état d'ami comme « en ligne », et arrive donc par les deux
   * mêmes événements plutôt que par un canal réservé à la VR - c'est ce qui
   * permet de le découvrir depuis cette page, sans avoir déjà le casque.
   */
  let inVrFriends = new Set<string>();
  let selectedFriend: any = null;

  /*
   * Le salon de chaque ami ne se tient plus ici : `$friendRooms` est ce que le
   * serveur dit de l'appartenance de chacun (`rooms/friend-rooms.ts`). Ce
   * composant le déduisait des salons qu'il voyait passer, rangés par leur
   * créateur - et un créateur parti restait « dans un salon » tant que le salon
   * lui survivait.
   */
  /*
   * Nommés, et enregistrés puis retirés avec LA MÊME référence.
   *
   * `VrShell.svelte` écoute ces deux évènements-là sur le même socket et reste
   * monté pendant toute une session VR ; en socket.io v4, `off(event)` sans
   * gestionnaire retire TOUS les écouteurs de l'évènement, donc le
   * `off('friends:online')` nu qui était ici arrachait aussi le sien. Le
   * symptôme - « mes amis ne passent plus jamais en VR dans le casque, ni en
   * ligne d'ailleurs », sans une erreur de console - n'accuse aucun des deux
   * fichiers. `VrShell.svelte` a payé exactement ce piège dans l'autre sens et
   * son bloc de `teardown` nomme ses six gestionnaires pour cette raison.
   */
  function handleFriendsOnline(friendsWithStatus: any[]) {
    onlineFriends = new Map(friendsWithStatus.map(f => [f.id, f.online]));
    inVrFriends = new Set(friendsWithStatus.filter(f => f.inVr).map(f => f.id));
  }

  function handleFriendStatusChanged({ userId, online, inVr }: any) {
    onlineFriends.set(userId, online);
    onlineFriends = onlineFriends; // Trigger reactivity
    /*
     * Un `inVr` absent ne fait rien, au lieu de valoir « non ».
     *
     * Le champ est émis par les trois émetteurs de cet événement, mais un
     * serveur d'avant ce changement - le temps d'un déploiement - l'omettrait,
     * et `undefined` étant faux, un ami présent en VR sortirait du lobby au
     * premier changement de statut sans rapport.
     */
    if (inVr !== undefined) {
      if (inVr) inVrFriends.add(userId);
      else inVrFriends.delete(userId);
      inVrFriends = inVrFriends; // Trigger reactivity
    }
  }

  onMount(async () => {
    const mode = get(currentHomeMode);
    if (isOfflineMode(mode)) {
      // Aucune requête : elle échouerait, et la socket n'existe pas.
      friends = mode.kind === 'offline-account' ? readKnownFriends(localStorage, mode.account.id) : [];
      return;
    }

    // Load friends
    const res = await fetch('/api/friends', { credentials: 'include' });
    if (res.ok) {
      friends = await res.json();
      if ($user && !$user.isAnonymous) rememberFriends(localStorage, $user.id, friends);
    }

    // Load pending requests
    const reqRes = await fetch('/api/friends/requests', { credentials: 'include' });
    if (reqRes.ok) {
      friendRequests = await reqRes.json();
    }

    // Listen for initial online status, and for the changes that follow.
    // Both by reference - see the two handlers above.
    $socket?.on('friends:online', handleFriendsOnline);
    $socket?.on('friend:statusChanged', handleFriendStatusChanged);

    // Request initial online status (after listeners are set up)
    $socket?.emit('friends:getOnlineStatus');

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
      // Un nouvel ami peut déjà être dans un salon, et rien d'autre ne le dirait
      // avant qu'il en change.
      $socket?.emit('friends:getOnlineStatus');
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
    // Named: `VrShell.svelte` binds these same two
    // events on the same socket, and a bare off() took its listeners down too.
    $socket?.off('friends:online', handleFriendsOnline);
    $socket?.off('friend:statusChanged', handleFriendStatusChanged);
    $socket?.off('friend:requestReceived');
    $socket?.off('friend:requestAccepted');
    $socket?.off('friend:requestRejected');
    $socket?.off('friend:removed');
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
      $socket?.emit('friends:getOnlineStatus');
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
    // La fiche d'un ami ne propose que de le retirer, ce qui demande le serveur.
    if (actionsOff) return;
    dispatch('friendClicked', friendData);
  }

  /*
   * Inviter, puis le dire au tiroir qui nous porte.
   *
   * Une fois l'invitation partie, la suite se passe ailleurs - le bandeau du
   * groupe dit qui l'on attend - et le tiroir restait ouvert par-dessus. Seul
   * ce bouton le ferme : les autres gestes de la liste le gardent ouvert.
   */
  async function invite(friendId: string) {
    await inviteToGroup(friendId);
    dispatch('invited');
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
      <button
        on:click={() => showAddFriend = !showAddFriend}
        class="btn-add"
        disabled={actionsOff}
        title={actionTitle}
      >
        +
      </button>
    </div>

    {#if offlineNote}
      <p class="offline-note" role="status">{offlineNote}</p>
    {/if}

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
              <button on:click={() => acceptRequest(request.id)} class="btn-accept" disabled={actionsOff} title={actionTitle}>✓</button>
              <button on:click={() => rejectRequest(request.id)} class="btn-reject" disabled={actionsOff} title={actionTitle}>✗</button>
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
          {@const room = $friendRooms.get(friendData.friend.id)}
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
                {#if actionsOff}
                  <!-- Sans socket personne n'est en ligne : rien à affirmer. -->
                {:else if room}
                  <!-- A room can be waiting with no game chosen yet, and a blank
                       line there says nothing at all - so name the state
                       instead of the game. -->
                  <small class="room-status">{room.gameTitle ?? t($language, 'inLobby')}</small>
                {:else if onlineFriends.get(friendData.friend.id)}
                  <!-- « En VR » imbriqué sous « en ligne », et pas à côté :
                       c'est ce qui fait que hors ligne prime. Un socket fermé
                       ne porte pas de casque, et sans cela un ami dont la
                       déconnexion arrive avant sa sortie de VR resterait en VR
                       jusqu'au rechargement de la page. Une partie, elle, prime
                       sur les deux : elle est testée plus haut. -->
                  {#if inVrFriends.has(friendData.friend.id)}
                    <small class="vr-status">{t($language, 'vrInVr')}</small>
                  {:else}
                    <small class="online-status">{t($language, 'online')}</small>
                  {/if}
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
                disabled={actionsOff}
                title={actionTitle}
                on:click|stopPropagation={() => cancelGroupInvitation($myRoom?.invitation?.id ?? '')}
              >
                {t($language, 'invitedWaiting')} ✕
              </button>
            {:else if !groupFull && !groupBusy && !invitedId}
              <button
                class="btn-invite-friend"
                disabled={actionsOff}
                title={actionTitle}
                on:click|stopPropagation={() => invite(friendData.friend.id)}
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
        {@const room = $friendRooms.get(friendData.friend.id)}
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

  /* Le dégradé violet qui était ici ne correspondait à rien dans
     l'application - c'était le tell générique que la reprise a chassé
     partout ailleurs. La forme vient maintenant du plancher ; il ne reste
     que la couleur et le fait que ce bouton-là est carré. */
  .btn-add {
    background: var(--go);
    border-color: var(--go-deep);
    color: #ffffff;
    width: 34px;
    height: 34px;
    padding: 0;
    font-size: 1.25rem;
    line-height: 1;
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
    border-color: var(--edge);
    box-shadow: 0 0 0 3px rgba(248, 208, 48, 0.18);
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

  /* Accepter et refuser : les deux verbes du monde, et les deux couleurs
     qui les portent partout ailleurs. Un vert et un rouge inventés sur
     place les rendaient étrangers à leur propre application. */
  .btn-accept {
    background: var(--go);
    border-color: var(--go-deep);
    color: #ffffff;
    padding: 0.15rem 0.6rem;
  }

  .btn-reject {
    background: var(--stop);
    border-color: var(--stop-deep);
    color: #ffffff;
    padding: 0.15rem 0.6rem;
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
    background: var(--go);
    border-color: var(--go-deep);
    color: #ffffff;
    font-size: 0.95rem;
    padding: 0.2rem 0.7rem;
  }

  /* Éteint, et lisible comme tel : le plancher baisse l'opacité, ceci retire
     le vert qui dit « appuie ici ». */
  .btn-invite-friend:disabled,
  .btn-add:disabled {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.25);
    cursor: not-allowed;
  }

  .offline-note {
    margin: 0 0 1rem;
    font-size: 0.85rem;
    line-height: 1.4;
    color: #b8b8c8;
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
    color: var(--edge);
    font-weight: 500;
  }

  .info .online-status {
    color: #4caf50;
    font-weight: 500;
  }

  .info .offline-status {
    color: #888;
  }

  /* L'accent du HUD, celui que `.room-status` emploie déjà juste au-dessus.
     Pas « la couleur de la VR » : il n'en existe aucune dans cette feuille.
     C'est celle que ce fichier réserve aux états plus précis que la simple
     présence, et « en VR » en est un - le vert, lui, ne dit que « en ligne ».
     Conséquence assumée ici et pas tranchée : « En VR » et le nom du salon
     sont donc peints à l'identique, ce qui est une décision de design. */
  .info .vr-status {
    color: var(--edge);
    font-weight: 500;
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
    border-color: rgba(248, 208, 48, 0.6);
  }

  .compact-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .compact-avatar .icon {
    font-size: 1.5rem;
  }

  /* Un aplat d'or : le dégradé violet n'appartenait à rien, et une pastille
     qui réclame un regard a tout intérêt à porter l'accent du HUD. */
  .compact-avatar.notification-badge {
    background: var(--edge);
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

  /* Vert, parce que ce point dit « cette personne joue en ce moment » -
     c'est l'état, pas une décoration, et le vert le dit déjà partout. */
  .badge-dot.in-room {
    background: var(--go);
    box-shadow: 0 0 8px rgba(47, 132, 32, 0.7);
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
