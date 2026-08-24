<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { socket, waitForSocket } from '$lib/api/socket';
  import { goto, replaceState } from '$app/navigation';
  import { page } from '$app/stores';
  import { user } from '$lib/stores/user';
  import { games } from '$lib/stores/games';
  import type { Game } from '$lib/stores/games';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import P2PRoom from '$lib/components/P2PRoom.svelte';
  import LockstepRoom from '$lib/components/LockstepRoom.svelte';
  import SoloRoom from '$lib/components/SoloRoom.svelte';
  import RoomPlayers from '$lib/components/RoomPlayers.svelte';
  import ConfirmModal from '$lib/components/ConfirmModal.svelte';
  import type { Room } from '$lib/types';
  import { EmulationMode } from '$lib/types';
  import { defaultControlsConfig, normaliseControlsConfig, type ControlsConfig } from '$lib/controls/binding';
  import { onlinePlayers } from '$lib/rooms/online-players';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('RoomPage');

  // Check if current user is the room creator (only they can change mode)
  $: isRoomCreator = room?.createdBy === $user?.id;

  export let data;

  let room: Room | null = null;
  let gameStarted = false;

  /**
   * Whether any room state has arrived yet for this component instance.
   *
   * The resume check below needs "was it already playing when we got here",
   * and `!gameStarted` alone does not say that: the server sets the status to
   * playing and emits room:updated *before* it emits game:started, so on an
   * ordinary start the first thing we see is a playing room we are not yet in.
   */
  let seenRoomState = false;
  let showToast = false;
  let toastMessage = '';
  let toastType: 'success' | 'error' = 'success';
  /** My two-player config, from my account - the one the panel edits. */
  let userControls: ControlsConfig = defaultControlsConfig();

  $: roomId = data.roomId;

  // Get current user's key configuration
  $: currentPlayer = room?.players.find(p => p.userId === $user?.id);

  /**
   * Player 1's mapping.
   *
   * The room protocol carries only one mapping per member: a remote peer
   * occupies port 2, not a second local player. The emulators therefore never
   * need more than this half.
   */
  $: keyConfig = currentPlayer?.keyConfig || userControls.p1.keys;

  // Determine if current player is the room host
  $: isRoomHost = room?.hostId === $user?.id;

  /*
   * Online, not member count.
   *
   * A partner who closed their tab is still in `room.players`, so counting
   * members here would put a single player into netplay: two cores exchanging
   * inputs with nobody on the other end. The invite panel still counts members
   * - an away member's seat is theirs - which is why these two disagree.
   */
  $: isSinglePlayer = room ? onlinePlayers(room).length <= 1 : true;

  // Determine effective emulation mode for game start
  $: effectiveEmulationMode = isSinglePlayer ? EmulationMode.SINGLE : room?.emulationMode;

  /**
   * The mode the running game was started in, frozen at `game:started`.
   *
   * `effectiveEmulationMode` is derived from the live player count, so a single
   * `room:updated` carrying one player - a socket.io reconnect is enough, and
   * the emulator stalling the main thread makes those routine - flipped it to
   * SINGLE mid-game. That swapped the rendered component, which destroyed the
   * running emulator and mounted an independent single-player one; when the
   * peer came back it was rebuilt from scratch and the game restarted. A game
   * in progress keeps the mode it began with.
   *
   * `game:started` on rejoin was the hole in this guard: the server re-sends
   * it to anyone joining a `playing` room, so `handleGameStarted` reran and
   * called `enterGame` a second time with the live (possibly collapsed) mode,
   * overwriting the value this variable exists to freeze. It now no-ops once
   * `gameStarted` is already true.
   */
  let activeEmulationMode: EmulationMode | null = null;

  // Check if at least one player is ready (has a port)
  $: canStartGame = room?.players.some(p => p.port !== null && p.isReady) ?? false;

  /**
   * The chosen game, narrowed once, or null while the room has none.
   *
   * The emulator components need a definite id and title; `room.gameId` is now
   * optional because a room can exist before anyone has picked anything.
   */
  $: chosenGame = room?.gameId
    ? { id: room.gameId, title: room.gameTitle ?? '', crc32: room.gameCrc32 }
    : null;

  /** The library to choose from, and the friends who can be invited into it. */
  let friends: { friendshipId: string; friend: { id: string; displayName: string; avatar?: string } }[] = [];
  let showGamePicker = false;
  let showInvite = false;

  /**
   * The one invitation this room is waiting on, as the server describes it.
   *
   * It rides on the *public* room view (`room:update` and GET /api/rooms), not
   * on `room:updated`: the raw room has no idea invitations exist. That is what
   * makes the panel below a fact about the room rather than about this tab -
   * it survives a reload, and the other player sees the same thing.
   */
  interface PendingInvitation {
    id: string;
    toUserId: string;
    toDisplayName: string;
    toAvatar?: string;
    /**
     * An ISO string, not a Date: Socket.IO serialises dates on the way out and
     * never revives them, so this is parsed before anything is done with it.
     */
    expiresAt: string;
  }

  let pendingInvitation: PendingInvitation | null = null;
  /** Whether a public view has landed, so the slower HTTP seed cannot overwrite it. */
  let sawRoomView = false;
  /** Set when we could not enter at all; the screen stops waiting and says so. */
  let entryFailed = '';
  let now = Date.now();
  let clock: ReturnType<typeof setInterval> | undefined;

  /**
   * The invitation still standing at this instant.
   *
   * The server resolves expiry when it builds the view, but a screen left open
   * outlives that answer: without a clock of its own this panel would go on
   * saying "waiting for Bob" long after the ten minutes ran out, and would keep
   * hiding the friend list that the player needs to invite anybody again.
   */
  $: liveInvitation =
    pendingInvitation && new Date(pendingInvitation.expiresAt).getTime() > now
      ? pendingInvitation
      : null;

  /**
   * `at` and `lang` are arguments rather than reads of `now` and `$language`,
   * so the template tracks them: an expression whose dependencies are hidden
   * inside a function body never re-runs when they change, and this one ticks.
   */
  function expiryLabel(invitation: PendingInvitation, at: number, lang: 'en' | 'fr'): string {
    const minutes = Math.ceil((new Date(invitation.expiresAt).getTime() - at) / 60_000);
    return minutes <= 1
      ? t(lang, 'expiresInAMinute')
      : t(lang, 'expiresInMinutes', { count: minutes });
  }
  /**
   * The picker opens by itself on a room that has no game, once.
   *
   * After that first state it obeys the button: reopening it on every
   * `room:updated` would fight the player who just closed it.
   */
  let pickerDecided = false;
  $: if (room && !pickerDecided) {
    pickerDecided = true;
    showGamePicker = !room.gameId;
  }

  /**
   * Whether we got here by answering an invitation.
   *
   * `lobby:accept` does not look at the room's status, so an invitation
   * answered after the launch seats the invitee straight into a running game.
   * The seat is legitimately theirs - `room:join` has always behaved this way -
   * so nothing is refused; but a screen that dropped them into a match without
   * a word would be pretending this was an ordinary arrival.
   */
  let arrivedByInvitation = false;
  /**
   * The save this room was opened on, if the library sent us here to resume.
   *
   * Carried down to whichever emulator component runs, which asks the server
   * for it once the session is playing. Nothing here applies it: the existing
   * `game:load` / `game:loaded` pair does, exactly as the pause menu does.
   */
  let resumeSaveId: string | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Whether this component is still mounted.
   *
   * `onMount` registers its listeners after an await while `onDestroy` runs
   * synchronously, so a short-lived visit can destroy the component inside that
   * window. A leaked `handleGameStarted` would then set `document.body.overflow`
   * to hidden on whatever page the player actually ended up on, and no `off`
   * would ever come for it.
   */
  let alive = true;

  function handleReconnect() {
    logger.info('Socket reconnected, rejoining room');
    $socket?.emit('room:join', { roomId });
  }

  function handleRoomUpdated(updatedRoom: Room) {
    if (updatedRoom.id !== roomId) return;

    const firstStateForThisMount = !seenRoomState;
    seenRoomState = true;
    room = updatedRoom;

    // Said once, on arrival, and only to someone who came in through an
    // invitation: they were asked to join a room and landed in a match that was
    // already running. Nothing is taken away from them - the seat is theirs -
    // but they are told what happened instead of being dropped into it.
    if (firstStateForThisMount && arrivedByInvitation && updatedRoom.status === 'playing') {
      showNotification(t($language, 'joinedInProgress'), 'success');
    }

    /*
     * A match already playing in the very first room state we receive means
     * we arrived into one - a reload, a recovered crash, or a fresh join into
     * a running room. `!gameStarted` alone cannot tell that apart from an
     * ordinary start: the server emits room:updated before game:started, so
     * even a normal start's playing state reaches us while gameStarted is
     * still false. What separates the two is whether that playing state is
     * the first one this mount has seen at all. Lockstep only, and only with
     * both seats still filled - the netplay session resumes by rejoining a
     * peer that is still there, and there is nothing to rejoin otherwise.
     *
     * The mode is read from the room rather than from
     * `effectiveEmulationMode`, for two reasons. It is a `$:` value and so is
     * still stale in this tick, and it collapses to SINGLE whenever the room
     * momentarily holds one player - which is exactly what happens while the
     * other player is reconnecting, and would drop us into a single-player
     * emulator instead of the match.
     */
    if (
      firstStateForThisMount &&
      !gameStarted &&
      updatedRoom.status === 'playing' &&
      updatedRoom.emulationMode === EmulationMode.LOCKSTEP &&
      updatedRoom.players.length >= 2 &&
      updatedRoom.players.some(p => p.userId === $user?.id)
    ) {
      logger.info('Rejoining a match already in progress');
      enterGame(EmulationMode.LOCKSTEP);
    }
  }

  /**
   * The public view of this room, which is the only payload carrying the
   * pending invitation.
   *
   * `room` itself comes from `room:updated`, the raw room with every player's
   * keyConfig; this one is `toPublicRoom`, broadcast as `room:update`, and it
   * is read only for the invitation - it has no keyConfig, so it cannot
   * replace `room` without dropping the local player's controls.
   */
  function handleRoomView(view: {
    id: string;
    invitation?: PendingInvitation;
  }) {
    if (view?.id !== roomId) return;
    sawRoomView = true;
    // Absent means the room is waiting on nobody - invited and then cancelled,
    // answered, or run out - and that is what brings the friend list back.
    pendingInvitation = view.invitation ?? null;
  }

  function showNotification(message: string, type: 'success' | 'error' = 'success') {
    toastMessage = message;
    toastType = type;
    showToast = true;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      showToast = false;
    }, 4000);
  }

  /**
   * The server's refusals, said out loud.
   *
   * Every lobby action here can be refused - a room that filled up, a friend
   * who is no longer one, a game changed after the launch - and this screen
   * used to swallow all of it, leaving a button that looked like it had done
   * nothing.
   */
  function handleSocketError(payload: { message?: string }) {
    if (!payload?.message) return;
    /*
     * An error that arrives before we ever had a room is fatal for this page,
     * not a passing complaint: it means we could not get in. Toasting it and
     * leaving "joining the room" on screen is what made a dead room look like
     * a slow one, for ever - the observed case being a restart that outlasted
     * the seat's grace, after which the room was gone and every retry answered
     * the same way. Once we are in a room, an error is an incident and the
     * toast is right.
     */
    if (!room) {
      entryFailed = payload.message;
      return;
    }
    showNotification(payload.message, 'error');
  }

  function handleInviteSent() {
    showNotification(t($language, 'invitationSent'), 'success');
  }

  function handleInviteDeclined(payload: { roomId: string; displayName: string }) {
    if (payload?.roomId !== roomId) return;
    showNotification(t($language, 'invitationDeclined', { name: payload.displayName }), 'error');
  }

  function handleInviteCancelled(payload: { roomId: string }) {
    if (payload?.roomId !== roomId) return;
    showNotification(t($language, 'invitationCancelled'), 'success');
  }

  /**
   * The library, always re-read rather than trusted from the store.
   *
   * A direct visit to a room URL never ran the library page, so the store is
   * empty; a client-side arrival from it may have a list that predates the last
   * game added. Either player picks from their own library, which is also the
   * only one the server will look in.
   */
  async function loadMyGames() {
    try {
      const res = await fetch('/api/games', { credentials: 'include' });
      if (!res.ok) return;
      const gamesData: Game[] = await res.json();
      gamesData.sort((a, b) => a.title.localeCompare(b.title));
      games.set(gamesData);
    } catch (error) {
      logger.error('Failed to load games:', error);
    }
  }

  async function loadFriends() {
    try {
      const res = await fetch('/api/friends', { credentials: 'include' });
      if (res.ok) friends = await res.json();
    } catch (error) {
      logger.error('Failed to load friends:', error);
    }
  }

  /**
   * Seeds the pending invitation from the HTTP room list, for the reload path.
   *
   * The reload path, and the only one there is: rejoining a seat you already
   * hold answers with `room:updated` alone, which carries no invitation, so
   * without this the panel would come back on every reload while the
   * invitation was still running.
   */
  async function seedPendingInvitation() {
    try {
      const res = await fetch('/api/rooms', { credentials: 'include' });
      if (!res.ok) return;
      const rooms: {
        id: string;
        invitation?: PendingInvitation;
      }[] = await res.json();
      const mine = rooms.find(r => r.id === roomId);
      if (!mine) return;
      if (!sawRoomView) pendingInvitation = mine.invitation ?? null;
    } catch (error) {
      logger.error('Failed to read the pending invitation:', error);
    }
  }

  function chooseGame(game: Game) {
    // Only the id and the title travel. The checksum and the cover are read
    // from the chooser's own row on the server, which is the only copy either
    // player can trust.
    $socket?.emit('room:choose-game', { roomId, gameId: game.id, gameTitle: game.title });
    showGamePicker = false;
  }

  function inviteFriend(friendId: string) {
    $socket?.emit('lobby:invite', { roomId, friendId });
  }

  /**
   * Take the invitation back.
   *
   * Either member may do this, which is why the button is not the sender's
   * alone. The panel is not hidden here: the server's broadcast of the room
   * view is what removes it, so both screens change for the same reason and a
   * refusal leaves the invitation visibly still standing.
   */
  function cancelInvitation(invitationId: string) {
    $socket?.emit('lobby:cancel', { invitationId });
  }

  function enterGame(mode: EmulationMode) {
    activeEmulationMode = mode;
    gameStarted = true;

    // Prevent scrolling when game is active
    if (browser) {
      document.body.style.overflow = 'hidden';
    }
  }

  function handleGameStarted() {
    // The server re-emits `game:started` to anyone rejoining a room that is
    // already `playing` - every reconnect and every reload. Re-running
    // `enterGame` there re-derives the mode from `effectiveEmulationMode`,
    // which collapses to SINGLE while the room momentarily holds one player,
    // and swapping to it destroys the running LockstepRoom. Once a game has
    // started, resume has already picked the mode from `room.emulationMode`
    // in `handleRoomUpdated`; there is nothing left for this handler to do.
    if (gameStarted) return;
    enterGame(effectiveEmulationMode ?? EmulationMode.SINGLE);
  }

  function handleGameStopped() {
    activeEmulationMode = null;
    // Restore scrolling
    if (browser) {
      document.body.style.overflow = '';
    }

    // Redirect to home when game is stopped
    goto('/');
  }

  onMount(async () => {
    arrivedByInvitation = $page.url.searchParams.get('from') === 'invitation';
    // Read once at mount, not reactively: which save this room was opened on is
    // a fact about the arrival. Rereading it would re-apply the save if the URL
    // were ever revisited mid-session.
    resumeSaveId = $page.url.searchParams.get('save');

    const sock = await waitForSocket();
    // The component can be gone by now - a click through to another page while
    // the layout is still awaiting /auth/me is enough. `onDestroy` has already
    // run, so anything registered past this point would never be removed.
    if (!alive) return;

    /*
     * The parameter is read once and then spent.
     *
     * The message it triggers is about *this arrival*, and a parameter left in
     * the address bar outlives the arrival: it survives a reload, a bookmark, a
     * copied link and the back button, firing for people who were never invited
     * and re-firing for the one who was - which teaches the player that the
     * toast means nothing. `replaceState` strips it with no navigation and no
     * load run.
     *
     * After the await, not before, and not for tidiness: on a cold load this
     * component's onMount runs synchronously while SvelteKit is still
     * constructing the root, before the router marks itself started - and
     * `replaceState` throws there in development. Waiting for the socket puts
     * us well past it, because the socket is not created until the layout has
     * finished awaiting /auth/me.
     */
    if (arrivedByInvitation) replaceState(`/room/${roomId}`, $page.state);

    if (!sock) {
      goto('/');
      return;
    }

    // Load user's personal control configuration
    try {
      const res = await fetch('/api/user/controls', { credentials: 'include' });
      if (res.ok) {
        const config = await res.json();
        userControls = normaliseControlsConfig(config);
      }
    } catch (error) {
      logger.error('Failed to load user controls:', error);
    }

    // Checked a second time, and this is the one that matters. The guard above
    // covers `waitForSocket`, but the controls fetch just above is a real
    // network round trip - long enough to navigate away inside. Everything
    // below attaches listeners that outlive this component, one of which
    // navigates, so a destroyed instance must stop here rather than there.
    if (!alive) return;

    // The lobby's own material: what can be chosen, who can be invited, and
    // the invitation this room may already be waiting on. Not awaited - the
    // room state is what the screen needs first, and each of these fills in
    // its own corner when it lands.
    void loadMyGames();
    void loadFriends();
    void seedPendingInvitation();

    // Join room
    sock.emit('room:join', { roomId });

    // Rejoin after a reconnect. The server drops a player from the room when
    // its socket disconnects, and socket.io reconnects on its own - but
    // `room:join` only ran in onMount, so the player stayed dropped. The room
    // then sat at one player permanently, which is also what pushed a running
    // game into single-player mode.
    sock.on('connect', handleReconnect);
    sock.on('room:updated', handleRoomUpdated);
    sock.on('room:update', handleRoomView);
    sock.on('game:started', handleGameStarted);
    sock.on('game:stopped', handleGameStopped);
    sock.on('error', handleSocketError);
    sock.on('lobby:invite-sent', handleInviteSent);
    sock.on('lobby:invitation-declined', handleInviteDeclined);
    sock.on('lobby:cancelled', handleInviteCancelled);

    // Ticks the expiry label, and drops the panel by itself when the ten
    // minutes run out with nobody having answered - no broadcast comes for
    // that, because nothing happened on the server.
    clock = setInterval(() => (now = Date.now()), 15_000);
  });

  onDestroy(() => {
    alive = false;

    if ($socket) {
      /*
       * No `room:leave` here, deliberately, and this line is the whole point of
       * the release.
       *
       * Emitting it on unmount made navigating to the library a permanent
       * departure - and the last one out destroyed the room - which is why
       * playing together twice took two invitations. Leaving is a button now,
       * and going away is just a socket that is no longer here.
       */
      // With the handler, not without: a bare off('connect') removes every
      // connect listener on the shared socket, including the ones that keep
      // the reconnection banner and the netplay slot alive.
      $socket.off('connect', handleReconnect);
      $socket.off('room:updated', handleRoomUpdated);
      $socket.off('room:update', handleRoomView);
      $socket.off('game:started', handleGameStarted);
      $socket.off('game:stopped', handleGameStopped);
      $socket.off('error', handleSocketError);
      $socket.off('lobby:invite-sent', handleInviteSent);
      $socket.off('lobby:invitation-declined', handleInviteDeclined);
      $socket.off('lobby:cancelled', handleInviteCancelled);
    }

    clearInterval(clock);
    clearTimeout(toastTimer);

    if (browser) {
      document.body.style.overflow = '';
    }
  });

  function startGame() {
    $socket?.emit('game:start', { roomId });
  }

  let confirmingLeave = false;

  /*
   * The only path that gives up a seat.
   *
   * This used to be a bare `goto('/')`, because `onDestroy` emitted
   * `room:leave` for it - which is exactly the coupling this release removes.
   * With the unmount silent, the event has to be sent from here or nobody could
   * ever give up a seat at all.
   *
   * Confirmed because it is not undoable from this side: the other player has
   * to invite you again, and if you were the last one out the room goes with
   * its invitations.
   */
  function leaveRoom() {
    confirmingLeave = false;
    $socket?.emit('room:leave', { roomId });
    goto('/');
  }

  // Lockstep first: it is the only mode that cannot silently drift apart, and
  // it is now the default for new rooms. Dual is last - it is still the one
  // that desyncs.
  const modeOptions = [
    { mode: EmulationMode.LOCKSTEP, label: 'lockstepMode', badge: '' },
    { mode: EmulationMode.STREAMING, label: 'streamingMode', badge: '' },
    { mode: EmulationMode.DUAL, label: 'dualMode', badge: 'Alpha' }
  ] as const;

  function modeDescriptionKey(mode: EmulationMode | undefined) {
    if (mode === EmulationMode.DUAL) return 'dualModeDesc' as const;
    if (mode === EmulationMode.LOCKSTEP) return 'lockstepModeDesc' as const;
    return 'streamingModeDesc' as const;
  }

  function setEmulationMode(mode: EmulationMode) {
    if (!isRoomCreator) return;
    $socket?.emit('room:setEmulationMode', { roomId, emulationMode: mode });
  }
</script>

<div class="room-container">
  {#if !gameStarted}
    <div class="lobby">
      {#if room?.gameCoverUrl}
        <img src={room.gameCoverUrl} alt={room.gameTitle ?? ''} class="game-cover" />
      {:else if !room}
        <h1>{t($language, 'loading')}</h1>
      {:else if room.gameTitle}
        <h1>{room.gameTitle}</h1>
      {:else}
        <!-- Not the loading string, which is what stood here: a room with no
             game is not a room still on its way, and telling the player to wait
             for something nobody is sending is worse than a blank. -->
        <h1 class="no-game">{t($language, 'noGameChosen')}</h1>
      {/if}

      {#if room}
        <RoomPlayers {room} {roomId} />

        <!-- Emulation Mode selector (only shown when 2+ players).
             Three modes now rather than two, so a segmented control replaces
             the old on/off toggle. -->
        {#if !isSinglePlayer}
          <div class="mode-toggle-container">
            <div class="mode-segments" role="group" aria-label={t($language, 'emulationMode')}>
              {#each modeOptions as option}
                <button
                  type="button"
                  class="mode-segment"
                  class:active={room.emulationMode === option.mode}
                  disabled={!isRoomCreator}
                  aria-pressed={room.emulationMode === option.mode}
                  on:click={() => setEmulationMode(option.mode)}
                >
                  {t($language, option.label)}
                  {#if option.badge}<span class="alpha-badge">{option.badge}</span>{/if}
                </button>
              {/each}
            </div>
            <p class="mode-description">{t($language, modeDescriptionKey(room.emulationMode))}</p>
          </div>
        {/if}

        <!-- Only while waiting: the server refuses a game change once the
             room has started, so offering one here would be a button that
             cannot work. -->
        {#if room.status === 'waiting'}
          <div class="lobby-setup">
            <div class="setup-buttons">
              <button class="btn-setup" class:on={showGamePicker} on:click={() => (showGamePicker = !showGamePicker)}>
                {room.gameId ? t($language, 'changeGame') : t($language, 'chooseGame')}
              </button>
              <!-- The button goes away entirely while an invitation stands:
                   the server allows one at a time, so a second one would only
                   earn a refusal. The panel below says who is being waited on
                   and offers the way out. -->
              {#if room.players.length < 2 && !liveInvitation}
                <button class="btn-setup" class:on={showInvite} on:click={() => (showInvite = !showInvite)}>
                  {t($language, 'inviteFriend')}
                </button>
              {/if}
            </div>

            {#if showGamePicker}
              <div class="panel">
                {#if $games.length === 0}
                  <p class="panel-empty">{t($language, 'emptyLibrary')}</p>
                {:else}
                  <ul class="panel-list">
                    {#each $games as game (game.id)}
                      <li>
                        <button
                          class="panel-row picker-row"
                          class:chosen={game.id === room.gameId}
                          disabled={!game.crc32}
                          on:click={() => chooseGame(game)}
                        >
                          <span class="panel-name">{game.title}</span>
                          <!-- Without a checksum the server has nothing to give
                               either player to find the file with, so this one
                               cannot be chosen until it has been located once
                               from the library. -->
                          {#if !game.crc32}
                            <span class="panel-note">{t($language, 'needsRom')}</span>
                          {/if}
                        </button>
                      </li>
                    {/each}
                  </ul>
                {/if}
                <p class="panel-hint">{t($language, 'ownLibraryOnly')}</p>
              </div>
            {/if}

            <!-- One invitation at a time, so the friend list is replaced rather
                 than shown alongside: there is nobody left to invite until this
                 one is cancelled, answered, or runs out. -->
            {#if liveInvitation}
              <div class="panel">
                <div class="panel-row invited-row">
                  {#if liveInvitation.toAvatar}
                    <img class="invited-avatar" src={liveInvitation.toAvatar} alt="" />
                  {/if}
                  <span class="panel-name">
                    {t($language, 'waitingForInvitee', { name: liveInvitation.toDisplayName })}
                  </span>
                  <span class="panel-note">{expiryLabel(liveInvitation, now, $language)}</span>
                  <button class="btn-cancel-invite" on:click={() => cancelInvitation(liveInvitation.id)}>
                    {t($language, 'cancelInvitation')}
                  </button>
                </div>
                <p class="panel-hint">{t($language, 'onlyOneInvitation')}</p>
              </div>
            <!-- The same capacity condition as the button that opens this.
                 `showInvite` is sticky on purpose - cancelling an invitation
                 should hand the list straight back - but the room filling up
                 is the one case where the list must close on its own, and
                 without this it reappeared the moment the invitation stopped
                 being pending, which is exactly when the guest arrived. -->
            {:else if showInvite && room.players.length < 2}
              <div class="panel">
                {#if friends.length === 0}
                  <p class="panel-empty">{t($language, 'noFriendsYet')}</p>
                {:else}
                  <ul class="panel-list">
                    {#each friends as friendData (friendData.friendshipId)}
                      <li>
                        <div class="panel-row">
                          <span class="panel-name">{friendData.friend.displayName}</span>
                          <button class="btn-invite" on:click={() => inviteFriend(friendData.friend.id)}>
                            {t($language, 'invite')}
                          </button>
                        </div>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        <div class="actions">
          <!-- No game, no launch: the server would refuse it, and there is
               nothing to run. -->
          <button on:click={startGame} class="btn-start" disabled={!canStartGame || !room.gameId}>
            {t($language, 'startGame')}
          </button>
          <button on:click={() => (confirmingLeave = true)} class="btn-leave">
            {t($language, 'leaveRoom')}
          </button>
        </div>

        {#if !room.gameId}
          <p class="start-hint">{t($language, 'chooseGameToStart')}</p>
        {/if}
      {:else if entryFailed}
        <p class="entry-failed">{t($language, 'roomGone')}</p>
        <p class="entry-failed-detail">{entryFailed}</p>
        <a class="btn-leave" href="/">{t($language, 'backToLibrary')}</a>
      {:else}
        <p class="loading">{t($language, 'joiningRoom')}</p>
      {/if}
    </div>
  {:else if chosenGame}
    <!-- `chosenGame` rather than `room`: nothing can run without a game, and it
         carries the definite id and title the emulator components need. -->
    {#if activeEmulationMode === EmulationMode.SINGLE}
      <!-- Solo runs on the znet stack too now, so it gets the same core,
           renderer, shaders and save chrome the lockstep room has. -->
      <SoloRoom
        {roomId}
        gameId={chosenGame.id}
        gameCrc32={chosenGame.crc32}
        gameTitle={chosenGame.title}
        controls={userControls}
        {resumeSaveId}
        on:controlsSaved={(e) => (userControls = e.detail.config)}
      />
    {:else if activeEmulationMode === EmulationMode.LOCKSTEP}
      <!-- Lockstep runs on its own deterministic core and its own relay, so it
           shares nothing with the WebRTC path in P2PRoom. -->
      <LockstepRoom
        {roomId}
        gameId={chosenGame.id}
        gameCrc32={chosenGame.crc32}
        gameTitle={chosenGame.title}
        isHost={isRoomHost}
        {keyConfig}
        controls={userControls}
        latencyMode={room?.latencyMode ?? 'auto'}
        canSetLatency={isRoomCreator}
        {resumeSaveId}
        on:controlsSaved={(e) => (userControls = e.detail.config)}
      />
    {:else}
      <!-- P2PRoom handles the dual and streaming modes -->
      <P2PRoom
        {roomId}
        gameId={chosenGame.id}
        gameCrc32={chosenGame.crc32}
        gameTitle={chosenGame.title}
        isHost={isRoomHost}
        {keyConfig}
        controls={userControls}
        emulationMode={activeEmulationMode ?? EmulationMode.SINGLE}
        on:controlsSaved={(e) => (userControls = e.detail.config)}
      />
    {/if}
  {/if}

  {#if showToast}
    <div class="toast toast-{toastType}">
      <span class="toast-icon">{toastType === 'success' ? '✅' : '❌'}</span>
      <span>{toastMessage}</span>
    </div>
  {/if}
</div>

{#if confirmingLeave}
  <ConfirmModal
    title={t($language, 'leaveRoom')}
    message={t($language, 'leaveRoomWarning')}
    confirmText={t($language, 'leaveRoom')}
    danger={true}
    on:confirm={leaveRoom}
    on:cancel={() => (confirmingLeave = false)}
  />
{/if}

<style>
  .room-container {
    height: 100vh;
    width: 100vw;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow: hidden;
  }

  .room-container:has(.lobby) {
    padding: 2rem;
  }

  .lobby {
    max-width: 800px;
    width: 100%;
    text-align: center;
  }

  .game-cover {
    width: 400px;
    height: auto;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    margin-bottom: 1rem;
  }

  h1 {
    font-size: 2rem;
    margin-bottom: 2rem;
  }

  h1.no-game {
    color: #8b8ba3;
    font-weight: 500;
  }

  .lobby-setup {
    margin: 2rem 0 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .setup-buttons {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .btn-setup {
    background: #2a2a3a;
    border: 1px solid #3d3d52;
    color: #d6d6e6;
    padding: 0.5rem 1.1rem;
    border-radius: 8px;
    font-size: 0.95rem;
    cursor: pointer;
  }

  .btn-setup:hover {
    border-color: #667eea;
    color: #fff;
  }

  .btn-setup.on {
    background: #3a4a5a;
    border-color: #667eea;
    color: #fff;
  }

  .panel {
    width: 100%;
    max-width: 28rem;
    background: #1f1f2b;
    border: 1px solid #3d3d52;
    border-radius: 10px;
    padding: 0.75rem;
    text-align: left;
  }

  .panel-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 15rem;
    overflow-y: auto;
  }

  .panel-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0.6rem;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #d6d6e6;
    font-size: 0.95rem;
    text-align: left;
  }

  .picker-row {
    cursor: pointer;
  }

  .picker-row:hover:not(:disabled) {
    background: #2a2a3a;
    color: #fff;
  }

  .picker-row:disabled {
    cursor: not-allowed;
    color: #6f6f85;
  }

  .picker-row.chosen {
    background: rgba(102, 126, 234, 0.18);
    color: #fff;
  }

  .panel-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .panel-note {
    flex-shrink: 0;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #f59e0b;
  }

  .panel-empty,
  .panel-hint {
    color: #8b8ba3;
    font-size: 0.8rem;
    margin: 0.5rem 0.6rem 0;
  }

  .btn-invite {
    flex-shrink: 0;
    background: #667eea;
    border: none;
    color: #fff;
    padding: 0.3rem 0.8rem;
    border-radius: 6px;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .btn-invite:hover {
    background: #7b8ff0;
  }

  /* The name takes the slack so the deadline and the cancel button stay put
     together on the right, rather than drifting apart with the name's length. */
  .invited-row .panel-name {
    flex: 1;
  }

  .invited-avatar {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    object-fit: cover;
  }

  .btn-cancel-invite {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid #6b4a4a;
    color: #f0a0a0;
    padding: 0.3rem 0.8rem;
    border-radius: 6px;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .btn-cancel-invite:hover {
    background: #3a2a2a;
    color: #ffc9c9;
  }

  .start-hint {
    color: #8b8ba3;
    font-size: 0.875rem;
    margin: 0.75rem 0 0;
  }

  .mode-toggle-container {
    margin: 2rem 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .mode-description {
    color: #888;
    font-size: 0.875rem;
    margin: 0;
  }

  .mode-segments {
    display: inline-flex;
    background: #2a2a3a;
    border: 1px solid #3d3d52;
    border-radius: 10px;
    padding: 0.25rem;
    gap: 0.25rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .mode-segment {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: transparent;
    border: none;
    border-radius: 7px;
    color: #8b8ba3;
    font-size: 0.95rem;
    font-weight: 500;
    padding: 0.45rem 1rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .mode-segment:hover:not(:disabled):not(.active) {
    color: #d6d6e6;
  }

  .mode-segment.active {
    background: #667eea;
    color: #fff;
    font-weight: 600;
  }

  .mode-segment:disabled {
    cursor: not-allowed;
  }

  /* Only the creator can change the mode; everyone else still needs to read
     which mode is selected, so dim the unselected options rather than the
     whole control. */
  .mode-segment:disabled:not(.active) {
    opacity: 0.55;
  }

  .alpha-badge {
    font-size: 0.65rem;
    padding: 0.15rem 0.4rem;
    background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
    color: #000;
    border-radius: 4px;
    font-weight: 700;
    text-transform: uppercase;
    vertical-align: middle;
  }

  .actions {
    display: flex;
    gap: 1rem;
    justify-content: center;
    margin-top: 2rem;
  }

  .btn-start {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 1rem 2rem;
    font-size: 1.125rem;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-start:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  }

  .btn-start:disabled {
    background: #333;
    color: #666;
    cursor: not-allowed;
    opacity: 0.5;
  }

  .btn-leave {
    background: #333;
    color: white;
    border: none;
    padding: 1rem 2rem;
    font-size: 1.125rem;
    border-radius: 8px;
    cursor: pointer;
  }

  .entry-failed {
    margin: 0 0 0.25rem;
    color: #f87171;
    font-weight: 600;
  }

  .entry-failed-detail {
    margin: 0 0 1rem;
    color: #9aa0b4;
    font-size: 0.9rem;
  }

  .loading {
    text-align: center;
    color: #888;
    font-size: 1.125rem;
    margin: 2rem 0;
  }

  .toast {
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    background: rgba(42, 42, 42, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 1rem 1.5rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    z-index: 2000;
    animation: slideIn 0.3s ease-out;
    backdrop-filter: blur(10px);
  }

  .toast-success {
    border-left: 4px solid #4caf50;
  }

  .toast-error {
    border-left: 4px solid #f44336;
  }

  .toast-icon {
    font-size: 1.25rem;
  }

  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
</style>
