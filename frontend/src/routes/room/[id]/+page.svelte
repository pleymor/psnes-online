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
  import TopBar from '$lib/components/TopBar.svelte';
  import { inGame } from '$lib/stores/in-game';
  import SaveGrid from '$lib/components/SaveGrid.svelte';
  import type { SaveSummary } from '$lib/saves/api';
  import type { Room } from '$lib/types';
  import { EmulationMode } from '$lib/types';
  import { defaultControlsConfig, normaliseControlsConfig, type ControlsConfig } from '$lib/controls/binding';
  import { resumeSaveToRequest } from '$lib/rooms/resume-save';
  import { rememberRoom, recallRoom, forgetRoom } from '$lib/rooms/remembered-room';
  import { deriveRoomView, subscribeToRoom } from '$lib/rooms/room-session';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('RoomPage');

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

  /**
   * The room this page is in.
   *
   * Seeded from the route, and normally the same thing - but not bound to it.
   * `rebuildRoom` can move us into a room the URL does not name yet, and the
   * `replaceState` that follows does not re-run `load`, so `data` would go on
   * naming the dead one for the rest of the visit. A real navigation to another
   * room does change `data.roomId`, and that still wins: hence the comparison
   * rather than a plain `let`.
   */
  let routeRoomId = data.roomId;
  let roomId = data.roomId;
  $: if (data.roomId !== routeRoomId) {
    routeRoomId = data.roomId;
    roomId = data.roomId;
  }

  /** One rebuild at a time, so a refusal cannot become a loop of them. */
  let rebuildingRoom = false;

  /**
   * Set once the player has chosen to leave, and never unset.
   *
   * Forgetting the room on the way out is not enough on its own: quitting emits
   * `room:release-game`, the server answers `room:updated`, and that
   * reassignment re-runs the note-keeping below - which wrote the note
   * straight back after it had been cleared. Pressing Back then rebuilt the
   * room the player had just left. The flag is what makes leaving stick
   * against a reply still in flight.
   */
  let departing = false;

  /**
   * Player 1's mapping.
   *
   * The room protocol carries only one mapping per member: a remote peer
   * occupies port 2, not a second local player. The emulators therefore never
   * need more than this half.
   *
   * Read from my own config rather than from my row in `room.players`, even
   * though the server puts my mapping there too (`room-handlers.ts`, which
   * fills it from `getUserKeyConfig(user.id)`). The room's copy of *my*
   * mapping can never be more authoritative than what I just saved, and while
   * it was the source here it actively undid a rebind: an emulator applying
   * one locally dispatches `controlsSaved`, this page assigns `userControls`,
   * and that invalidation re-ran this statement in the same flush - pushing
   * the room's pre-save `keyConfig` straight back down. The rebind then only
   * took effect once `room:updated` came back, and never at all with the
   * socket down: the exact failure a7052da was written to fix.
   */
  $: keyConfig = userControls.p1.keys;

  /**
   * What the lobby needs to know about the room and the viewer, derived in one
   * place by `deriveRoomView` - see that function for what each field means
   * and why (online count vs. member count, the resume-mode gate, and so on).
   *
   * Called from a `$:` that names both its inputs, not from a nested access:
   * Svelte 4 reads a statement's dependencies from the identifiers written in
   * it, and a call whose arguments hide them would freeze the whole view at
   * mount.
   */
  $: view = deriveRoomView(room, $user?.id);

  /**
   * The mode the running game was started in, frozen at `game:started`.
   *
   * `view.effectiveMode` is derived from the live player count, so a single
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

  /*
   * My own library row for this room's ROM, and the saves on it.
   *
   * Matched on the checksum rather than on `room.gameId`, because each player
   * has their own `Game` row for the same dump: when the guest picked the game,
   * the room carries *their* id and looking it up in my library finds nothing.
   * This is the same distinction `saveSuitsRoom` makes on the server, and the
   * reason `Room.gameCrc32` exists at all. The id fallback keeps rooms whose
   * game predates local ROMs, and so has no checksum, working as before.
   *
   * The summaries come from the library store, which already holds them for
   * every game: asking `/api/games/:id/saves` instead would download the
   * savestates themselves to draw a row of thumbnails.
   */
  $: myGameForRoom = room
    ? ($games.find(g => room?.gameCrc32 && g.crc32 === room.gameCrc32)
        ?? $games.find(g => g.id === room?.gameId)
        ?? null)
    : null;
  $: myRoomSaves = (myGameForRoom?.saves ?? []) as SaveSummary[];

  let showSavePicker = false;

  /** Set when we could not enter at all; the screen stops waiting and says so. */
  let entryFailed = '';

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
   * Only the arrival's half of the answer: the room itself carries the staged
   * save now, and `resumeSaveId` below is resolved from both.
   */
  let urlSaveId: string | null = null;
  /**
   * The save whichever emulator component will start on, when this client is the
   * one that gets to ask for it.
   *
   * Carried down as a prop, and the component asks the server for it once the
   * session is playing - nothing here applies it, the existing `game:load` /
   * `game:loaded` pair does, exactly as the pause menu does. Which is why this
   * is resolved once, when the game starts, rather than reactively: the
   * components null their copy after using it so that a reconnect cannot rewind
   * the game, and a reactive value would push the save straight back down on the
   * next `room:updated`.
   *
   * Which member asks is a rule of its own, in `resumeSaveToRequest`: a guest
   * asking for the creator's staged save earns a refusal and nothing else, while
   * the resume works perfectly around it.
   */
  let resumeSaveId: string | null = null;
  let resumeSaveResolved = false;
  $: if (gameStarted && !resumeSaveResolved) {
    resumeSaveId = resumeSaveToRequest(room, view.isCreator, urlSaveId);
    resumeSaveResolved = true;
  }
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
  /** The teardown `subscribeToRoom` hands back; set once `onMount` wires it up. */
  let unsubscribeRoom: (() => void) | undefined;

  function handleReconnect() {
    logger.info('Socket reconnected, rejoining room');
    $socket?.emit('room:join', { roomId });
  }

  /*
   * Keep the tab's note about this room in step with the room itself.
   *
   * Only while it is a room of one: a room with a partner in it does not die
   * with one window, so there is nothing a reload would need to rebuild - and
   * rebuilding one would put the two players in different rooms. The note is
   * dropped rather than left stale when a second member arrives, so a reload
   * after that gets the honest error instead of a room built behind the
   * partner's back.
   */
  $: if (!departing && room?.gameId) {
    if (room.players.length <= 1) {
      rememberRoom({ roomId, gameId: room.gameId, gameTitle: room.gameTitle ?? '' });
    } else {
      forgetRoom();
    }
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
     * `view.effectiveMode`, for two reasons. It is a `$:` value and so is
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
  /**
   * Rebuilds the room under a game that is still running.
   *
   * A room of one dies with its player's window, and on a phone that window
   * closes by being backgrounded for the length of a ping timeout. The
   * emulator never noticed: it runs entirely here, holding the only copy of
   * the play that matters. So the room is the thing that was lost, and the
   * room is bookkeeping - a game, a seat, an id - all of which we still have.
   * Rebuilding it is cheaper for everyone than telling the player their room
   * is gone while they are plainly still playing in it.
   *
   * Solo only. In a netplay room the partner is in the real room, and building
   * a second one would put the two players in different places while telling
   * neither; there the complaint is the honest answer.
   *
   * The emulator is not touched. It is not re-keyed and does not remount, so
   * the machine, its audio and its battery carry straight across; `roomId`
   * reaches it as a prop, which is all it needs to address the new room for
   * saves and for the battery.
   */
  function rebuildRoom(game: { id: string; title: string }) {
    const sock = $socket;
    if (!sock || rebuildingRoom) return;

    rebuildingRoom = true;
    const settle = setTimeout(() => {
      // The rebuild is best-effort: if it does not come back, say the thing we
      // would have said in the first place rather than leaving it silent.
      if (!rebuildingRoom) return;
      rebuildingRoom = false;
      sock.off('room:created', onRebuilt);
      showNotification(t($language, 'roomGone'), 'error');
    }, 8000);

    function onRebuilt(created: Room) {
      clearTimeout(settle);
      rebuildingRoom = false;
      sock!.off('room:created', onRebuilt);
      roomId = created.id;
      room = created;
      // The URL has to stop naming a room that no longer exists, or a reload
      // lands on the error screen. No navigation: this page is already the
      // right page, and navigating would destroy the running emulator.
      replaceState(`/room/${created.id}`, $page.state);
      /*
       * Entering the game is this path's own job when it arrives without one.
       *
       * `room:create` does not emit `game:started` - the library's solo launch
       * gets into the game by navigating to the room, and `room:join` is what
       * hands a newcomer a running one. Rebuilding does neither: the page is
       * already here and nobody joined anything. Solo, because only a room of
       * one is ever rebuilt.
       */
      if (created.status === 'playing' && !gameStarted) enterGame(EmulationMode.SINGLE);
      logger.info('Rebuilt the room', { roomId: created.id, wasInGame: gameStarted });
      showNotification(t($language, 'roomReopened'), 'success');
    }

    sock.on('room:created', onRebuilt);
    // `autoStart`, because the game did not stop: the room has to come back in
    // the state the player is already in, not in a lobby they would have to
    // start out of.
    sock.emit('room:create', { gameId: game.id, gameTitle: game.title, autoStart: true });
  }

  function handleSocketError(payload: { message?: string; code?: string; roomId?: string }) {
    if (!payload?.message) return;

    /*
     * Our own room, refused on the way back in, with a game still running in
     * front of the player. Rebuilt rather than reported; see `rebuildRoom`.
     */
    if (payload.code === 'roomGone' && payload.roomId === roomId) {
      /*
       * Two ways to be holding a room the server has forgotten, and the
       * difference is only where the game's name comes from.
       *
       * Mid-game we still have the room object, so `chosenGame` has it. On
       * arrival - which is what a reload is, and a reload is what kills a room
       * of one in the first place - there is no room and no game, only an id
       * the server has never heard of. That is what the tab's note is for.
       */
      const game = chosenGame
        ? { id: chosenGame.id, title: room?.gameTitle ?? '' }
        : (() => {
            const noted = recallRoom(roomId);
            return noted ? { id: noted.gameId, title: noted.gameTitle } : null;
          })();

      if (game) {
        rebuildRoom(game);
        return;
      }
      // Nothing remembered: a hand-typed URL, or another tab's room. The
      // honest answer is that it is gone.
    }
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

  /*
   * Stage the save this room will start on, or clear it.
   *
   * Through the server rather than into a local variable: in lockstep both
   * machines boot from the same state, and the guest's lobby has to be able to
   * say what it will be. The server refuses a save that is not the caller's or
   * not this ROM's - here, in the lobby, instead of at boot over a running game.
   */
  function chooseSave(save: SaveSummary) {
    $socket?.emit('room:choose-save', { roomId, saveId: save.id });
    showSavePicker = false;
  }

  function clearStartingSave() {
    $socket?.emit('room:choose-save', { roomId, saveId: null });
  }

  function enterGame(mode: EmulationMode) {
    activeEmulationMode = mode;
    gameStarted = true;
    // The invitation card steps aside while this is true: a panel over an
    // emulator steals a click, and accepting would walk out of this match.
    inGame.set(true);

    // Prevent scrolling when game is active
    if (browser) {
      document.body.style.overflow = 'hidden';
    }
  }

  function handleGameStarted() {
    // The server re-emits `game:started` to anyone rejoining a room that is
    // already `playing` - every reconnect and every reload. Re-running
    // `enterGame` there re-derives the mode from `view.effectiveMode`,
    // which collapses to SINGLE while the room momentarily holds one player,
    // and swapping to it destroys the running LockstepRoom. Once a game has
    // started, resume has already picked the mode from `room.emulationMode`
    // in `handleRoomUpdated`; there is nothing left for this handler to do.
    if (gameStarted) return;
    enterGame(view.effectiveMode ?? EmulationMode.SINGLE);
  }

  /**
   * Named to the partner: the other half of `room:release-game`.
   *
   * `game:stopped` already sends the partner home through `leaveGame` above -
   * that is the path a component in a running game already unmounts through.
   * This handler adds the one thing that path cannot say on its own: who did
   * it. Skipped for my own release, which I already acted on locally the
   * moment I clicked; `byUserId` is how the two are told apart.
   *
   * `departing` is set before the notification and the navigation, not after,
   * so a `room:updated` still in flight cannot re-run the note-keeping at
   * line 240 and fight the departure - the same reason `leaveGame` sets it
   * first.
   */
  function handleGameReleased(payload: { byUserId: string; byPseudo: string }) {
    if (payload.byUserId === $user?.id) return;

    departing = true;
    showNotification(t($language, 'gameReleasedNotice', { name: payload.byPseudo }), 'success');
    goto('/');
  }

  /**
   * Leaving the game, from either of the two things that end one.
   *
   * The server's `game:stopped` is one of them, and it is the only one that can
   * reach the *other* player of a netplay room. The quitting player's own
   * button is the other, and it deliberately does not wait for the broadcast to
   * come back: `room:release-game` is a room-scoped event, and the server
   * drops those without a word when it no longer has the room - which stopped
   * being exotic the moment a room of one began dying with its player's
   * window. The socket only has to go quiet for the ping timeout, which on a
   * phone costs a tunnel or a lock screen, and the emulator runs entirely in
   * the client and notices none of it. The player was then holding a game the
   * server had no record of, with a quit button that could only ask
   * permission from something with nothing left to answer.
   * `lobby-protocol.test.ts` pins that silence for `game:stop`, the sibling
   * event this one now stands in for on the way out of a game; both are
   * guarded the same way, by `getMemberRoom`.
   *
   * So this runs locally first and is safe to run twice, because a player who
   * quits a live room runs it again when the broadcast does arrive: assigning
   * the same values, and `goto` to the page we are already on.
   *
   * The rooms still emit `room:release-game` themselves rather than leaving it
   * here - they have their own ordering to keep around it, chiefly getting the
   * battery save out while the server still counts them as a member - and then
   * say so upwards, which is the `on:quit` below.
   */
  function leaveGame() {
    activeEmulationMode = null;
    inGame.set(false);
    // Restore scrolling
    if (browser) {
      document.body.style.overflow = '';
    }

    /*
     * A room of one ends with its game.
     *
     * Quitting used to leave the player in the library still holding an empty
     * room: a group banner for a group of one, and a Play button their own
     * room had disabled - one player may only be in one room. Leaving now
     * spares them undoing something they never asked for. The server destroys
     * the room as soon as its last member is out.
     *
     * Gated on the count because `game:stopped` reaches both players of a
     * netplay room, and there the room is exactly what they came back to.
     */
    if ((room?.players.length ?? 0) <= 1) {
      $socket?.emit('room:leave', { roomId });
    }

    // Chosen, so never rebuilt: without this, quitting and pressing Back would
    // put the player straight back into the room they had just left.
    departing = true;
    forgetRoom();

    // Redirect to home when game is stopped
    goto('/');
  }

  onMount(async () => {
    arrivedByInvitation = $page.url.searchParams.get('from') === 'invitation';
    // Read once at mount, not reactively: which save the *arrival* named is a
    // fact about the arrival. Rereading it would re-apply the save if the URL
    // were ever revisited mid-session.
    urlSaveId = $page.url.searchParams.get('save');

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

    // The lobby's own material: my library, which is what names this room's ROM
    // in my own rows and carries its saves. Not awaited - the room state is what
    // the screen needs first, and this fills in its own corner when it lands.
    void loadMyGames();

    // Join room
    sock.emit('room:join', { roomId });

    // Rejoin after a reconnect. The server drops a player from the room when
    // its socket disconnects, and socket.io reconnects on its own - but
    // `room:join` only ran in onMount, so the player stayed dropped. The room
    // then sat at one player permanently, which is also what pushed a running
    // game into single-player mode.
    unsubscribeRoom = subscribeToRoom({
      socket: sock,
      roomId,
      onRoom: handleRoomUpdated,
      onError: handleSocketError,
      onStarted: handleGameStarted,
      onReconnect: handleReconnect,
      onStopped: leaveGame,
      onGameReleased: handleGameReleased
    });
  });

  onDestroy(() => {
    alive = false;

    /*
     * No `room:leave` here, deliberately, and this line is the whole point of
     * the release.
     *
     * Emitting it on unmount made navigating to the library a permanent
     * departure - and the last one out destroyed the room - which is why
     * playing together twice took two invitations. Leaving is a button now,
     * and going away is just a socket that is no longer here.
     */
    unsubscribeRoom?.();

    clearTimeout(toastTimer);
    // A game does not go on running on a page that has been left.
    inGame.set(false);

    if (browser) {
      document.body.style.overflow = '';
    }
  });

  function startGame() {
    $socket?.emit('game:start', { roomId });
  }

  /**
   * The lobby's own quit button.
   *
   * The same action as quitting a running game (the product decision behind
   * this whole release): it detaches the room's game and sends both players
   * home, and never touches membership - the group survives. No confirmation,
   * for the same reason a game's own quit button has none: this is that
   * action, not the group-dissolving one `leaveRoom` used to be.
   *
   * There is no component's own `quitToLobby` to call this from - the button
   * lives on this page - so it emits `room:release-game` itself, exactly as
   * `quitToLobby` does from inside a game.
   */
  function releaseGame() {
    $socket?.emit('room:release-game', { roomId });

    /*
     * A room of one still gives up its seat on the way out - see the comment
     * on the matching check in `leaveGame`. A lobby that never started a game
     * is still a room, and one nobody else was ever in is still worth reaping
     * rather than leaving behind.
     */
    if ((room?.players.length ?? 0) <= 1) {
      $socket?.emit('room:leave', { roomId });
    }

    // Chosen, so never rebuilt. Same reason as in `leaveGame`.
    departing = true;
    forgetRoom();
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
    if (!view.isCreator) return;
    $socket?.emit('room:setEmulationMode', { roomId, emulationMode: mode });
  }
</script>

{#if !gameStarted}
  <!-- The bar comes with the friends list, which is the only place an invitation
       is sent from now - so a room keeps a way to invite without carrying a
       panel of its own. Never over a running game. -->
  <TopBar />
{/if}

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
        {#if !view.isSinglePlayer}
          <div class="mode-toggle-container">
            <div class="mode-segments" role="group" aria-label={t($language, 'emulationMode')}>
              {#each modeOptions as option}
                <button
                  type="button"
                  class="mode-segment"
                  class:active={room.emulationMode === option.mode}
                  disabled={!view.isCreator}
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

        <!-- Only while waiting: the server refuses a change once the room has
             started, so offering one here would be a button that cannot work.

             The game is not chosen here any more, and neither is the friend: both
             happen in the library now, and choosing a game there is what sends
             both players to this page. What is left is the starting save, which
             belongs to the room rather than to the library. -->
        {#if room.status === 'waiting' && view.isCreator && room.gameId && myRoomSaves.length > 0}
          <div class="lobby-setup">
            <div class="setup-buttons">
              <!-- Creator-only, like the latency mode: where the game starts is
                   not a private preference, it decides where both players begin.
                   And only with a save of my own to offer. -->
              <button class="btn-setup" class:on={showSavePicker} on:click={() => (showSavePicker = !showSavePicker)}>
                {t($language, 'startFromSave')}
              </button>
            </div>

            {#if showSavePicker && myGameForRoom}
              <div class="panel">
                <SaveGrid
                  gameId={myGameForRoom.id}
                  preloaded={myRoomSaves}
                  actionLabel={t($language, 'startHere')}
                  on:select={(e) => chooseSave(e.detail)}
                />
              </div>
            {/if}
          </div>
        {/if}

        <!-- Shown to both players, and outside the picker: what the room will
             start on is a fact about the room, not about whoever opened a panel.
             The guest reads it, the creator can undo it. -->
        {#if room.resumeSaveId}
          <div class="starting-save">
            <span class="starting-save-label">
              {t($language, 'startingFrom', { name: room.resumeSaveName ?? '' })}
            </span>
            {#if view.isCreator}
              <button class="btn-clear-save" on:click={clearStartingSave}>
                {t($language, 'startFromBeginning')}
              </button>
            {/if}
            {#if !view.canResume}
              <span class="starting-save-warning">{t($language, 'saveNeedsLockstep')}</span>
            {/if}
          </div>
        {/if}

        <div class="actions">
          <!-- No game, no launch: the server would refuse it, and there is
               nothing to run. -->
          <button on:click={startGame} class="btn-start" disabled={!canStartGame || !room.gameId}>
            {t($language, 'startGame')}
          </button>
          <button on:click={releaseGame} class="btn-leave">
            {t($language, 'releaseGame')}
          </button>
        </div>

        {#if !room.gameId}
          <!-- Not a state of the ordinary flow any more - the game is chosen
               before anyone arrives here - but a hand-typed URL still reaches it,
               so it says where the game comes from. -->
          <p class="start-hint">{t($language, 'chooseGameFromLibrary')}</p>
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
        allowLocalPlayer2={view.isSinglePlayer}
        on:quit={leaveGame}
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
        isHost={view.isHost}
        {keyConfig}
        controls={userControls}
        latencyMode={room?.latencyMode ?? 'auto'}
        canSetLatency={view.isCreator}
        {resumeSaveId}
        on:quit={leaveGame}
        on:controlsSaved={(e) => (userControls = e.detail.config)}
      />
    {:else}
      <!-- P2PRoom handles the dual and streaming modes -->
      <P2PRoom
        {roomId}
        gameId={chosenGame.id}
        gameCrc32={chosenGame.crc32}
        gameTitle={chosenGame.title}
        isHost={view.isHost}
        {keyConfig}
        controls={userControls}
        emulationMode={activeEmulationMode ?? EmulationMode.SINGLE}
        on:quit={leaveGame}
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

<style>
  .room-container {
    /*
     * Two heights, and the order matters.
     *
     * On a phone `100vh` is the *large* viewport - the window as it would be
     * with the address bar collapsed - so while that bar is on screen the
     * bottom of this box sits below what the player can see. The toolbar lives
     * there, and this page sets `body { overflow: hidden }` while a game runs:
     * the menu button was not merely hard to reach, it was unreachable, and
     * with it the only way to quit without a keyboard. `100dvh` follows the
     * visible window instead; the `100vh` line above stays for browsers that
     * do not know the unit.
     */
    height: 100vh;
    height: 100dvh;
    width: 100vw;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow: hidden;
  }

  .room-container:has(.lobby) {
    /* The bar takes the top of the page, so the lobby takes what is left rather
       than a second full viewport - which would push it off screen. */
    height: auto;
    flex: 1;
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

  .panel-empty,

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

  /* Sits between the lobby panels and the launch button, because that is the
     order it is read in: this is the last thing you check before starting. */
  .starting-save {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    margin: 1.5rem auto 0;
    padding: 0.7rem 1rem;
    max-width: 34rem;
    background: #2a2a3a;
    border: 1px solid #3d3d52;
    border-radius: 8px;
  }

  .starting-save-label {
    color: #e6e6f0;
    font-size: 0.9rem;
  }

  .btn-clear-save {
    flex-shrink: 0;
    background: transparent;
    color: #8ab4f8;
    border: 1px solid #3d3d52;
    border-radius: 6px;
    padding: 0.3rem 0.7rem;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .btn-clear-save:hover {
    border-color: #8ab4f8;
  }

  /* Full width so it reads as a sentence under the two controls rather than as
     a third one beside them. */
  .starting-save-warning {
    flex-basis: 100%;
    color: #f59e0b;
    font-size: 0.8rem;
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
