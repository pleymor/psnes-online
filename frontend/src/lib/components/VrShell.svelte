<script lang="ts">
  /**
   * The immersive session, mounted once in the layout.
   *
   * It lives beside `InvitationCard` for the reason that component's note at
   * `+layout.svelte:130` gives - the layout is the only place that is on screen
   * whatever the player is doing - and for a second reason of its own: it sits
   * above the `<slot />`, so a navigation underneath cannot unmount it.
   *
   * There is exactly one way out. The quit button, the Quest's system menu and
   * a headset put down on the table all arrive as `sessionend`, and
   * `xr-session.ts` guarantees the handler runs once.
   *
   * `xr-session.ts`'s `end()` only guards against a second call once the first
   * has actually settled - its `finished` flag is set from the `end` event, not
   * from the call itself. Two `leave()`s fired close together (the context-lost
   * path today, an in-VR quit button once one exists) could both reach
   * `session.end()` before either settles. `leaving` below is the guard against
   * that: it makes `leave()` itself re-entrancy-safe regardless of how many
   * places end up calling it.
   *
   * `teardown()` and `closeAnySession()` carry different preconditions, and the
   * three call sites are picked to match them rather than sharing one blindly:
   * `teardown()` assumes the browser's `XRSession` is already gone, which is
   * true only from `openVrSession`'s `onEnd` callback below. Anywhere this
   * component can stop existing without that having happened yet - a failure
   * partway through `enter()`, or an ordinary Svelte unmount - has to check
   * first, because a `session` that is still open with nothing left to call
   * `end()` on it is a player stuck in a black room with no way out but a
   * restart.
   */
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { vrRequested, vrActive } from '$lib/vr/entry';
  import { openVrSession, type VrSession } from '$lib/vr/xr-session';
  import { createVrScene, type VrScene } from '$lib/vr/scene';
  import { readAspectPreference } from '$lib/stores/aspect-preference';
  import { notifications } from '$lib/services/notification';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import { createPointer, sameTarget, type PointerTarget } from '$lib/vr/pointer';
  import {
    LIBRARY_PANEL_SIZE, layoutLibraryPanel, drawLibraryPanel,
    libraryRows, clampScroll, type LibraryState
  } from '$lib/vr/panels/library';
  import {
    FRIENDS_PANEL_SIZE, friendRows, layoutFriendsPanel, drawFriendsPanel
  } from '$lib/vr/panels/friends';
  import {
    PROFILE_PANEL_SIZE, layoutProfilePanel, drawProfilePanel
  } from '$lib/vr/panels/profile';
  import {
    LAUNCH_PANEL_SIZE, layoutLaunchPanel, drawLaunchPanel, type LaunchLabels
  } from '$lib/vr/panels/launch';
  import { launchOptions } from '$lib/vr/launch-options';
  import { activeRooms, myRoom } from '$lib/rooms/my-room';
  import { menuPressed, readVrPad, activeXrInputs } from '$lib/vr/pad';
  import {
    readPadMap, writePadMap, assignInput,
    LETTERS_MAP, THUMB_MAP,
    type VrPadMap, type VrButton, type XrInput
  } from '$lib/vr/pad-map';
  import {
    CONTROLS_PANEL_SIZE, layoutControlsPanel, drawControlsPanel,
    type ControlsLabels
  } from '$lib/vr/panels/controls';
  import { CaptureGate } from '$lib/controls/capture-gate';
  import { user } from '$lib/stores/user';
  import { games } from '$lib/stores/games';
  import { deviceLibrary } from '$lib/roms/device-library';
  import { resolvableHere, resolveQuietly, type MissReason } from '$lib/roms/provider';
  import type { PanelMesh } from '$lib/vr/panel-mesh';
  import { loadCore, AudioSink, SocketTransport, UpgradingTransport, type SessionEvent, type Transport } from '$lib/znet';
  import { createSoloEngine, type SoloEngine } from '$lib/rooms/solo-engine';
  import { createLockstepEngine, type LockstepEngine } from '$lib/rooms/lockstep-engine';
  import { createRoom, leaveGroup, chooseGameForGroup } from '$lib/rooms/actions';
  import { gameClick } from '$lib/rooms/game-click';
  import { resumeSaveToRequest } from '$lib/rooms/resume-save';
  import { decodeSram } from '$lib/rooms/sram';
  import { toBase64, fromBase64 } from '$lib/saves/base64';
  import { socket } from '$lib/api/socket';
  import { setLogLabels } from '$lib/utils/log-shipper';
  import type { PsnesCore } from '$lib/znet/core';

  const logger = createLogger('VrShell');

  let session: VrSession | null = null;
  let scene: VrScene | null = null;
  /** Guards `leave()` against re-entrant calls - see the header. */
  let leaving = false;

  /** Reassigned in `teardown()`, not just used, so a trigger physically
   *  held across a session boundary can't be read as a stale non-edge and
   *  swallow the next session's first press. */
  let pointer = createPointer();
  let library: PanelMesh | null = null;
  let libraryState: LibraryState = { games: [], ownedTotal: 0, scroll: 0 };
  let friendsPanel: PanelMesh | null = null;
  let friendEntries: Array<{ friend: { id: string; pseudo: string } }> = [];
  let onlineFriends = new Map<string, boolean>();
  let profilePanel: PanelMesh | null = null;
  let hovered: PointerTarget | null = null;
  /** Read once on entry: the picker that would change it does not exist in
   *  here, so it cannot change during a session. */
  let resolvable: string[] = [];

  let engine: SoloEngine | LockstepEngine | null = null;
  let audio: AudioSink | null = null;
  /**
   * The room this shell created and therefore owes the server.
   *
   * `createRoom` seats the player in a room, and nothing here used to give it
   * back: every VR game left one alive forever. The room outlived the session,
   * so the library page kept offering "back to the room" for a game that had
   * stopped, and - worse than a stray button - the player's friends saw them
   * as playing indefinitely, because `broadcastRoomUpdate` had no reason to
   * think otherwise.
   *
   * Only overwritten on a relaunch, never left behind: the server's own
   * `leaveCurrentRoom` gives up the previous room on every create, so the id
   * this holds is always the only one outstanding.
   */
  let ownedRoomId: string | null = null;
  /** Shown on the lectern when a launch could not read the file. */
  let launchNotice: string | null = null;
  /** The dump whose launch options the screen is showing, or null for the
   * checkerboard. */
  let launchFor: string | null = null;
  /**
   * A save staged before a group exists to carry it.
   *
   * Not "solo only" any more: `launch-options.ts`'s `chosenSaveId` reads this
   * whenever the room holds fewer than two players, which is a lone creator's
   * group room just as much as no room at all - `launch-options.ts` explains
   * why that rule is keyed on being a group rather than on a room existing.
   * Once a friend is really there, `room.resumeSaveId` takes over and this is
   * ignored, per the spec's D5.
   */
  let stagedSaveId: string | null = null;
  /**
   * The room and host-ness a live group game is playing under, and the save
   * still owed a `game:load` once the session first reports `running`.
   *
   * Snapshotted in `launchTogether` rather than read fresh from `$myRoom`
   * everywhere: `onSessionEvent` and `awaitSave`'s reply run outside that
   * function's closure, and `hostId` moving to the other player mid-game must
   * not change which peer this session was built to be.
   */
  let groupRoomId: string | null = null;
  let groupIsHost = false;
  /** Null once asked (or for a guest, who never asks - see `resume-save.ts`),
   * so a `running` after a resync cannot re-request and rewind the game. */
  let pendingResumeSaveId: string | null = null;
  /**
   * A plain `let`, set once in `enter()` and reassigned by the switch in
   * `activate()` - never `$: padMap = readPadMap(localStorage)`. Made
   * reactive, that statement would recompute on the very write it triggers
   * (`writePadMap` touches `localStorage`) and overwrite the assignment
   * before the panel ever repaints with it - the button would appear to do
   * nothing.
   */
  let padMap: VrPadMap = LETTERS_MAP;

  /**
   * Whether the curved screen is carrying the remap panel.
   *
   * Mutually exclusive with `launchFor`: one surface, one content. Whoever
   * opens one clears the other, and `closeRemap` hands the screen back to
   * whatever it was showing.
   */
  let remapOpen = false;
  /** The button waiting for its new input, or null. */
  let listeningFor: VrButton | null = null;
  /**
   * The same gate the flat controls screen uses.
   *
   * Its rule is the one this needs: an input already consumed cannot be
   * consumed again until it has been let go. The trigger that clicked a row is
   * held at that instant, and without the gate it would bind itself to the row
   * it just opened.
   */
  const captureGate = new CaptureGate();

  /** Who is in a running game, from the rooms the socket already publishes -
   *  the same source `TopBar` hands `FriendsList`. */
  $: playingByUserId = new Map(
    $activeRooms
      .filter((room) => room.status === 'playing')
      .flatMap((room) => room.players.map((p) => [p.userId, room.gameTitle ?? ''] as const))
  );

  // `playingByUserId` is read inside `repaintFriends()`, but Svelte 4 derives a
  // reactive statement's dependencies from the identifiers written in the
  // statement itself, not from what the functions it calls happen to read
  // (`renderer-surface.ts`'s header spells this trap out at length). Naming
  // `playingByUserId` here, not just `friendsPanel`, is what makes a friend
  // starting or ending a game while the panel is up repaint it - dropping this
  // reference would make the statement run once and never again.
  $: if (friendsPanel && playingByUserId) repaintFriends();

  // The room decides half of what this screen shows - the friend's readiness,
  // the staged save, whether the game changed under us. Not the save itself:
  // that is resolved once at launch, never reactively, or a `room:updated`
  // would push it back down over a running game.
  $: if (launchFor && $myRoom) repaintLaunch();
  /*
   * The library changes underneath too, and `repaintLaunch`'s own guard for a
   * dump that left the library only runs when something calls it. A folder
   * sync or a reload from the flat page - both share this store - would
   * otherwise leave a launch screen advertising a game this device no longer
   * has.
   */
  $: if (launchFor && $games) repaintLaunch();

  /*
   * The other way in.
   *
   * The friend can choose a game from their flat page, and then the room
   * carries it and this player never touched anything. It is also the only
   * path by which a game absent from THIS device can reach the launch screen -
   * the lectern only ever offers what `resolvableHere` returned - so it is the
   * path that earns the `rom-missing` refusal.
   */
  /*
   * `!remapOpen` is the guard that keeps a rebinding from being interrupted.
   *
   * A friend choosing a game would otherwise take the curved screen out from
   * under a player halfway through binding a button - and with `listeningFor`
   * still set, the next press would land on a panel nobody is looking at.
   * `closeRemap` runs `backToLaunchScreen`, which picks this up on the way
   * out, so nothing is lost by waiting.
   */
  $: if (!remapOpen && $myRoom?.gameCrc32 && $myRoom.gameCrc32 !== launchFor && $myRoom.status === 'waiting') {
    launchFor = $myRoom.gameCrc32;
    stagedSaveId = null;
    repaintLaunch();
  }

  /**
   * Cover art, and the one rule that decides whether this panel exists at all.
   *
   * `coverUrl` comes in two flavours and they need opposite treatment. An
   * uploaded cover is same-origin — `/api/covers/<id>` behind `requireAuth`
   * (`api/covers.ts:9`) — so it needs the session cookie and must NOT carry a
   * `crossOrigin` attribute, which would strip credentials and 401. A cover
   * from the community metadata is an absolute URL to somebody else's host
   * (`raw.githubusercontent.com/libretro-thumbnails/...`,
   * `images.launchbox-app.com/...`), and drawing one of those into a canvas
   * WITHOUT CORS taints it — after which WebGL refuses `texSubImage2D` on the
   * whole texture, so the panel renders with no map and, being transparent,
   * disappears entirely. Not a missing picture: a missing panel.
   *
   * So the attribute is set per URL. GitHub's thumbnails send
   * `Access-Control-Allow-Origin: *` and load fine; launchbox sends no CORS at
   * all, so those fail `onerror` and are skipped — a title with no box art,
   * which is what `drawLibraryPanel` already draws for an unidentified game.
   */
  const covers = new Map<string, CanvasImageSource>();

  /**
   * Save thumbnails, keyed by save id, and the reason they need none of the
   * care above.
   *
   * `Save.screenshot` is a PNG `data:` URL served inline by `/api/games`, not
   * a URL to anybody's host. A `data:` image cannot taint a canvas, so there
   * is no `crossOrigin` to set and no host that can refuse - the only failure
   * left is a malformed payload, which lands in `onerror` and leaves the row
   * with its two lines of text.
   */
  const saveShots = new Map<string, CanvasImageSource>();

  /** Whether a cover lives on somebody else's host, and so needs CORS. */
  function isForeign(url: string): boolean {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch {
      // An unparseable URL is not something to reason about; treat it as
      // foreign so it can only ever fail safely.
      return true;
    }
  }

  function repaintLibrary(): void {
    if (!library) return;
    library.regions = layoutLibraryPanel(libraryState);
    const regions = library.regions;
    const notice = launchNotice;
    // One `paint()`, not two: each call rasterises the whole canvas and
    // uploads a texture, so a second call for the notice overlay used to cost
    // a repeat of both for what is really one logical repaint.
    library.paint((ctx) => {
      drawLibraryPanel(ctx, libraryState, regions, {
        labels: {
          heading: t($language, 'library'),
          emptyLibrary: t($language, 'emptyLibrary'),
          emptyLibraryHint: t($language, 'vrAddGamesFlat'),
          noneHere: t($language, 'noneOnThisDevice', { count: libraryState.ownedTotal }),
          noneHereHint: t($language, 'vrAddGamesFlat')
        },
        hoverId: hovered?.panel === 'library' ? hovered.region.id : null,
        covers
      });
      if (notice) {
        ctx.save();
        ctx.fillStyle = '#7a2222';
        ctx.fillRect(0, 0, LIBRARY_PANEL_SIZE.width, 40);
        ctx.fillStyle = '#ffffff';
        ctx.font = '18px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(notice, LIBRARY_PANEL_SIZE.width / 2, 20);
        ctx.restore();
      }
    });
  }

  function repaintFriends(): void {
    if (!friendsPanel) return;
    const rows = friendRows(friendEntries, onlineFriends, playingByUserId);
    friendsPanel.regions = layoutFriendsPanel(rows);
    friendsPanel.paint((ctx) =>
      drawFriendsPanel(ctx, rows, [], {
        heading: t($language, 'friends'),
        online: t($language, 'online'),
        offline: t($language, 'offline'),
        nobody: t($language, 'vrNoFriends'),
        readOnly: t($language, 'vrFriendsReadOnly')
      })
    );
  }

  function repaintProfile(): void {
    if (!profilePanel) return;
    const state = {
      pseudo: $user?.pseudo ?? '',
      map: padMap,
      language: $language,
      playing: engine !== null
    };
    profilePanel.regions = layoutProfilePanel(state);
    const regions = profilePanel.regions;
    profilePanel.paint((ctx) =>
      drawProfilePanel(ctx, state, regions, {
        labels: {
          letters: t($language, 'vrPresetLetters'),
          thumb: t($language, 'vrPresetThumb'),
          quit: t($language, 'vrQuit'),
          resume: t($language, 'vrResume'),
          stopGame: t($language, 'vrStopGame'),
          remap: t($language, 'vrRemap'),
          controls: t($language, 'controls'),
          gripLeft: t($language, 'vrGripLeft'),
          gripRight: t($language, 'vrGripRight'),
          triggers: t($language, 'vrTriggers'),
          sticks: t($language, 'vrSticks'),
          dpad: t($language, 'vrDpad')
        },
        hoverId: hovered?.panel === 'profile' ? hovered.region.id : null
      })
    );
  }

  function repaintLaunch(): void {
    if (!scene || launchFor === null) return;
    const options = launchOptions({
      library: $games,
      crc32: launchFor,
      room: $myRoom ?? null,
      me: $user?.id ?? '',
      openable: new Set(resolvable ?? []),
      stagedSaveId,
      // What a save is CALLED, decided by the same `saveIdentity` the flat
      // grid uses. Without these two the headset prints the stored name, and
      // the quick save's stored name is the sentinel `__quick__`.
      locale: $language,
      quickSaveLabel: t($language, 'quickSave')
    });
    // The dump left the library while its screen was up - a folder sync can do
    // that. Back to the test pattern rather than a half-drawn screen.
    if (!options) {
      launchFor = null;
      scene.screen.regions.length = 0;
      scene.screen.showTestPattern();
      return;
    }

    const labels = launchLabels();
    const regions = layoutLaunchPanel(options, labels);
    // Replaced in place: `scene.aimedAt` holds this same array.
    scene.screen.regions.length = 0;
    scene.screen.regions.push(...regions);
    // Before the paint, so a thumbnail already decoded from an earlier visit
    // to this screen is in the map by the time the row is drawn.
    loadSaveShots(options.saves);
    scene.screen.paintPanel(LAUNCH_PANEL_SIZE, (ctx) =>
      drawLaunchPanel(ctx, options, regions, {
        labels,
        hoverId: hovered?.panel === 'screen' ? hovered.region.id : null,
        covers,
        shots: saveShots
      })
    );
  }

  /**
   * Decodes the save thumbnails this screen is about to draw.
   *
   * Keyed by save id and never evicted while the session lasts: a player moves
   * between the launch screen and a game repeatedly, and re-decoding the same
   * five PNGs each time is work with no visible result. `teardown` clears it
   * with everything else.
   */
  function loadSaveShots(saves: readonly { id: string; screenshot: string | null }[]): void {
    for (const save of saves) {
      if (!save.screenshot || saveShots.has(save.id)) continue;
      const image = new Image();
      image.onload = () => { saveShots.set(save.id, image); repaintLaunch(); };
      // A payload that will not decode. The row keeps its name and its date,
      // which is what identifies it anyway - the picture only ever confirmed.
      image.onerror = () => logger.warn('save thumbnail unreadable in VR', save.id);
      image.src = save.screenshot;
    }
  }

  function launchLabels(): LaunchLabels {
    return {
      newGame: t($language, 'vrNewGame'),
      saveLockedByCreator: t($language, 'vrSaveLockedByCreator'),
      launch: t($language, 'vrLaunch'),
      port1: t($language, 'vrPort1'),
      port2: t($language, 'vrPort2'),
      waitingForFriend: t($language, 'vrWaitingForFriend'),
      friendReady: t($language, 'vrFriendReady'),
      romMissing: t($language, 'vrRomMissing'),
      alreadyPlaying: t($language, 'vrAlreadyPlaying'),
      noSeat: t($language, 'vrNoSeat'),
      gameChanged: t($language, 'vrGameChanged'),
      friendAway: t($language, 'vrFriendAway'),
      friendAwayBlocked: t($language, 'vrFriendAwayBlocked')
    };
  }

  function repaintControls(): void {
    if (!scene || !remapOpen) return;
    const state = { map: padMap, listeningFor };
    const regions = layoutControlsPanel(state);
    // Replaced in place: `scene.aimedAt` holds this same array.
    scene.screen.regions.length = 0;
    scene.screen.regions.push(...regions);
    scene.screen.paintPanel(CONTROLS_PANEL_SIZE, (ctx) =>
      drawControlsPanel(ctx, state, regions, {
        labels: controlsLabels(),
        hoverId: hovered?.panel === 'screen' ? hovered.region.id : null
      })
    );
  }

  function controlsLabels(): ControlsLabels {
    return {
      heading: t($language, 'vrRemapHeading'),
      press: t($language, 'vrRemapPress'),
      presetLetters: t($language, 'vrPresetLetters'),
      presetThumb: t($language, 'vrPresetThumb'),
      done: t($language, 'vrRemapDone'),
      fixedDpad: t($language, 'vrFixedDpad'),
      fixedMenu: t($language, 'vrFixedMenu'),
      // Literals, not translation keys: "A" and "START" are silkscreened on
      // the cartridge pad and identical in both languages. Translating them
      // would invent a divergence between the screen and the plastic.
      button: {
        a: 'A', b: 'B', x: 'X', y: 'Y',
        l: 'L', r: 'R',
        start: 'START', select: 'SELECT'
      },
      input: {
        XrLeftTrigger: t($language, 'vrXrLeftTrigger'),
        XrRightTrigger: t($language, 'vrXrRightTrigger'),
        XrLeftSqueeze: t($language, 'vrXrLeftSqueeze'),
        XrRightSqueeze: t($language, 'vrXrRightSqueeze'),
        XrLeftFaceUpper: t($language, 'vrXrLeftFaceUpper'),
        XrRightFaceUpper: t($language, 'vrXrRightFaceUpper'),
        XrLeftFaceLower: t($language, 'vrXrLeftFaceLower'),
        XrRightFaceLower: t($language, 'vrXrRightFaceLower'),
        XrLeftStickClick: t($language, 'vrXrLeftStickClick')
      }
    };
  }

  /** Opens the remap panel, taking the curved screen from whatever held it. */
  function openRemap(): void {
    launchFor = null;
    remapOpen = true;
    listeningFor = null;
    captureGate.reset();
    repaintControls();
  }

  /**
   * Closes the remap panel and gives the screen back.
   *
   * Back to the game's picture while one is running, and to the launch options
   * otherwise - the same two states the screen has when nothing opened this
   * panel in the first place.
   */
  function closeRemap(): void {
    remapOpen = false;
    listeningFor = null;
    captureGate.reset();
    if (scene) scene.screen.regions.length = 0;
    if (engine) {
      scene?.screen.showPicture();
    } else {
      backToLaunchScreen();
    }
  }

  function loadCovers(list: typeof $games): void {
    for (const game of list) {
      if (!game.coverUrl || covers.has(game.id)) continue;
      const image = new Image();
      // Before `src`, or the attribute does not apply to the request. See the
      // note on `covers` for why this is per-URL rather than always or never.
      if (isForeign(game.coverUrl)) image.crossOrigin = 'anonymous';
      // Both surfaces: the lectern's grid AND the launch screen's jaquette.
      // Repainting only the library is what left the curved screen showing its
      // placeholder rectangle for the whole session - the cover had loaded,
      // nothing asked for it to be drawn again.
      image.onload = () => {
        covers.set(game.id, image);
        repaintLibrary();
        repaintLaunch();
      };
      // A host that sends no CORS headers lands here. Nothing to do: the game
      // keeps its title, and never entering `covers` is what stops a tainted
      // image from reaching the canvas.
      image.onerror = () => logger.warn('cover unavailable in VR', game.coverUrl);
      image.src = game.coverUrl;
    }
  }

  function activate(target: PointerTarget): void {
    if (target.panel === 'library') {
      if (target.region.id === 'scroll:up' || target.region.id === 'scroll:down') {
        const step = target.region.id === 'scroll:down' ? 1 : -1;
        libraryState = {
          ...libraryState,
          scroll: clampScroll(libraryState.scroll + step, libraryRows(libraryState))
        };
        repaintLibrary();
        return;
      }
      if (target.region.id.startsWith('game:')) {
        const gameId = target.region.id.slice('game:'.length);
        const game = libraryState.games.find((candidate) => candidate.id === gameId);
        // Picking a game hands the curved screen to the launch options, so the
        // remap panel stands down rather than leaving its regions behind on a
        // mesh that is drawing something else.
        remapOpen = false;
        listeningFor = null;
        // Stages the launch screen instead of launching straight away: the
        // screen is the only place a save can be chosen or a friend seen.
        /*
         * Not while a launch is in flight.
         *
         * Without this, staging game B over a launching game A left the
         * player looking at B's options while A booted underneath and took
         * the screen - and their click on B's `launch` was silently swallowed
         * by `launch`'s own `launching` guard. Worse, restaging the SAME game
         * cleared `stagedSaveId` before `launch` had read it, so a save the
         * player had explicitly chosen was dropped and the game started fresh
         * with no notice.
         */
        if (launching) return;
        if (!game?.crc32) return;
        const click = gameClick($myRoom);

        // `blocked` means the room is playing: the profile band carries the way
        // back into it, and there is nothing for this click to do.
        if (click.kind === 'blocked') {
          launchNotice = t($language, 'vrAlreadyPlaying');
          repaintLibrary();
          return;
        }

        launchFor = game.crc32;
        stagedSaveId = null;
        launchNotice = null;

        if (click.kind === 'choose-for-group') {
          // This is what opens the room, and it opens it for BOTH of us: the
          // server answers with `room:opened` to every member, which navigates
          // the friend to the room page. It does not navigate this player -
          // `+layout.svelte` returns early while `vrActive` is set, a guard
          // written to prevent an accident that turns out to be the mechanism.
          chooseGameForGroup(click.roomId, { id: game.id, title: game.title });
        }

        repaintLibrary();
        repaintLaunch();
      }
      return;
    }

    if (target.panel === 'profile') {
      const id = target.region.id;
      if (id === 'quit') { void leave(); return; }
      // Ends the GAME and stays in the headset. `quit` above ends the session
      // itself, which was the only way out of a running game and so the only
      // way back to the library: a player who had simply finished had to take
      // the headset off and put it back on.
      if (id === 'stop') { void stopTogether(); return; }
      if (id === 'remap') { openRemap(); return; }
      if (id === 'resume') {
        // Back to the game, so the game gets its screen back. The launch
        // screen is abandoned rather than kept: `launchFor` surviving here
        // would leave regions on a mesh that is a picture again. Same for the
        // remap panel, which lives on that same mesh.
        launchFor = null;
        remapOpen = false;
        listeningFor = null;
        captureGate.reset();
        if (scene) scene.screen.regions.length = 0;
        scene?.screen.showPicture();
        scene?.panelsVisible(false);
        return;
      }
      if (id === 'scheme:letters' || id === 'scheme:thumb') {
        writePadMap(localStorage, id === 'scheme:thumb' ? THUMB_MAP : LETTERS_MAP);
        // Read back rather than assumed: `readPadMap` is the only thing that
        // decides, and a preset written and not stored (the default is
        // removed, not stored) must still read back correctly.
        padMap = readPadMap(localStorage);
        repaintProfile();
        return;
      }
      if (id === 'lang:en' || id === 'lang:fr') {
        language.set(id === 'lang:en' ? 'en' : 'fr');
        // Every panel carries text.
        repaintLibrary();
        repaintFriends();
        repaintProfile();
        return;
      }
    }

    // Before the launch screen's own branch: both live on `scene.screen.regions`,
    // and only one of them owns the mesh at a time.
    if (target.panel === 'screen' && remapOpen) {
      const id = target.region.id;
      if (id.startsWith('bind:')) {
        listeningFor = id.slice('bind:'.length) as VrButton;
        /*
         * Offer the gate what is held RIGHT NOW, and throw the answer away.
         *
         * The trigger that just clicked this row is still down. Without this
         * priming call the gate's next tick would see it as a fresh press and
         * bind the trigger to the row the player only meant to select.
         */
        captureGate.reset();
        captureGate.tick(activeXrInputs(scene?.inputSources() ?? []));
        repaintControls();
        return;
      }
      if (id === 'preset:letters' || id === 'preset:thumb') {
        writePadMap(localStorage, id === 'preset:thumb' ? THUMB_MAP : LETTERS_MAP);
        // Read back rather than assumed, the same rule the profile band's own
        // preset buttons follow.
        padMap = readPadMap(localStorage);
        repaintControls();
        repaintProfile();
        return;
      }
      if (id === 'close') { closeRemap(); return; }
      return;
    }

    if (target.panel === 'screen') {
      const id = target.region.id;

      if (id.startsWith('save:')) {
        const saveId = id === 'save:none' ? null : id.slice('save:'.length);
        const room = $myRoom;
        if (room && room.players.length >= 2) {
          // Staged on the room so the friend sees what they are joining. The
          // server refuses this from anyone but the room's creator, which is
          // why the layout gave these rows no regions in that case - so
          // reaching here at all means it will be accepted.
          $socket?.emit('room:choose-save', { roomId: room.id, saveId });
        } else {
          stagedSaveId = saveId;
        }
        repaintLaunch();
        return;
      }

      if (id === 'port:1' || id === 'port:2') {
        const room = $myRoom;
        if (!room) return;
        // One emit: `room:selectPort` sets `isReady` as well, so choosing a
        // controller is also declaring yourself ready.
        $socket?.emit('room:selectPort', { roomId: room.id, port: id === 'port:1' ? 1 : 2 });
        return;
      }

      if (id === 'launch' && launchFor) {
        const room = $myRoom;
        if (room && room.players.length >= 2) {
          // Any member may start: `game:start` asks only for membership, a
          // chosen game and one seated player. The engine is built when
          // `game:started` comes back - not here, because the friend may
          // start it too.
          $socket?.emit('game:start', { roomId: room.id });
          return;
        }
        const game = entryFor(launchFor);
        if (game) void launch(game);
        return;
      }
      return;
    }
  }

  /** Guards `launch()` against overlapping itself - the same shape of problem
   *  `leaving` guards `leave()` against. A second trigger press landing while
   *  the first launch is still mid-flight (neither has reached `engine` yet)
   *  would otherwise slip past the `if (engine)` check below and construct
   *  two engines, both handed the same `scene.schedule`. */
  let launching = false;

  /** The library entry for a dump, by CRC32 - never by game id, for the reason
   * `launch-options.ts` gives at length. */
  function entryFor(crc32: string): (typeof $games)[number] | null {
    return $games.find((game) => game.crc32 === crc32) ?? null;
  }

  async function launch(game: (typeof $games)[number]): Promise<void> {
    if (!scene || launching) return;
    if (!game.crc32) return;

    launching = true;
    try {
      /*
       * `resolveQuietly`, never the picker.
       *
       * `resolvable` was read when the session opened, but a folder handle can
       * lose its permission between then and now. On the flat screen
       * `obtainRom()` answers that by opening `LocateRom`; in here there is no
       * modal to open, so the failure has to be a line on the panel. The game
       * stays in the grid: it exists, it just could not be read this time.
       *
       * `requestPermission: false` is not optional here: the trigger press that
       * got us into `launch()` is a real gesture, so without this the browser's
       * native permission dialog would fire and eject the player from the
       * headset to show it - the exact interruption this panel exists to avoid.
       */
      /*
       * The reason is carried onto the panel, not just logged.
       *
       * `resolveQuietly` answers null for five different situations and used to
       * look identical for all five, which cost a whole headset session: the
       * notice said the file could not be read and nobody could tell whether
       * the permission, the folder, or the file itself was the problem. There
       * is no console in here and the shipped logs are not readable from the
       * headset either, so the panel is the only channel that reaches the
       * person who can see the failure.
       */
      let miss: MissReason | null = null;
      const rom = await resolveQuietly(game.crc32, {
        requestPermission: false,
        onMiss: (reason) => { miss = reason; }
      });
      if (!rom) {
        launchNotice = `${t($language, 'vrRomUnreadable')} [${miss ?? 'unknown'}]`;
        logger.error('vr rom miss', { crc32: game.crc32, reason: miss });
        repaintLibrary();
        return;
      }

      const roomId = await createRoom({ gameId: game.id, gameTitle: game.title, autoStart: true });
      if (!roomId) {
        launchNotice = t($language, 'vrLaunchFailed');
        repaintLibrary();
        return;
      }
      setLogLabels({ roomId, player: 'vr' });
      ownedRoomId = roomId;

      /*
       * A second launch while one is already live - reachable straight from
       * the checklist's own flow: stick-click recalls the panels while the
       * game keeps running, then the player aims at a different tile. Stopped
       * here, and awaited, rather than left running underneath the new one:
       * two governors would otherwise fight over the one pending slot
       * `frame-pump.ts`'s `schedule` holds (both would get the same
       * `scene.schedule`), and the first engine's SRAM interval and
       * AudioContext would leak past it.
       *
       * Placed after the ROM and room are already secured, not before: a
       * launch that is about to fail on either must leave the game already
       * running untouched.
       */
      if (engine) {
        await engine.stop();
        engine = null;
        void audio?.stop();
        audio = null;
      }

      try {
        // Local, not component state: unlike `engine` and `audio`, nothing
        // outside this function ever reads `core` again once
        // `createSoloEngine` has it - the engine keeps its own reference via
        // closure (`solo-engine.ts`), and this component's own copy was
        // write-only.
        const core: PsnesCore = await loadCore();
        audio = new AudioSink();

        /*
         * Re-checked, not trusted from the entry guard at the top of this
         * function: `resolveQuietly` and `createRoom` above are real awaits -
         * `createRoom` up to a 5 s timeout - and a `sessionend` landing during
         * either drives `teardown()`, which nulls `scene` (and everything
         * else) out from under this continuation. Without this, `scene.schedule`
         * below would throw on a null `scene`; `activate()` calls `launch()`
         * with `void`, so that throw would be an unhandled rejection.
         */
        if (!scene) {
          void audio.stop();
          audio = null;
          return;
        }

        engine = await createSoloEngine({
          core,
          rom,
          sram: {
            load: () => readRoomSram(roomId),
            save: (bytes) => $socket?.emit('game:saveSram', { roomId, sramData: toBase64(bytes) })
          },
          audio,
          readPads: () => ({
            // Zero while the panels are up: the trigger is the pointer then,
            // and letting both read it at once would make a menu press also
            // register as SNES R.
            pad1: scene && !scene.arePanelsVisible()
              ? readVrPad(scene.inputSources(), padMap, sessionVisibility())
              : 0,
            pad2: 0
          }),
          onFrame: (c) => scene?.screen.upload(c.videoSurface()),
          onError: (err) => logger.error('vr engine', err),
          /*
           * The whole reason `GovernorOptions.schedule` exists, and the one line
           * that makes the chain behind it real.
           *
           * Without this the governor falls back to `window.requestAnimationFrame`,
           * which is NOT the display's clock once a headset is presenting - the
           * WebXR spec lets a user agent throttle it freely. The game would still
           * run, which is exactly what makes the omission dangerous: nothing looks
           * broken, and `frame-pump.ts`, the governor's new option and the XR
           * animation loop would all be dead weight.
           */
          schedule: scene.schedule
        });

        /*
         * `createSoloEngine`'s own awaits - the SRAM round trip, up to 5 s,
         * and `audioWorklet.addModule` - are exactly the kind that outlive a
         * closed session. A `sessionend` landing during either already drove
         * `teardown()` above, which nulled `scene`, `engine` and `audio` - and
         * without this check the assignment just above would put a live
         * engine straight back into `engine` right after `teardown()` cleared
         * it, leaking its governor and 30 s SRAM interval forever.
         *
         * Mirrors `SoloRoom.svelte`'s `destroyed` check. This component has no
         * separate flag: `scene` being null after `teardown()` is already the
         * signal, the same one the check above this call reads.
         */
        if (!scene) {
          void engine.stop();
          engine = null;
          giveUpRoom();
          /*
           * Optional, and that is the whole point of this block.
           *
           * The `sessionend` that nulled `scene` also ran `teardown()`, which
           * does `void audio?.stop(); audio = null;` on this same
           * component-scope variable. So by the time we get here `audio` is
           * usually already null, and a bare `audio.stop()` would throw -
           * replacing the accidental crash this guard exists to remove with a
           * second one, in the guard itself. It would be caught by the outer
           * try and logged as "vr engine failed to start", which is a lie:
           * the engine started fine and was then torn down on purpose.
           */
          void audio?.stop();
          audio = null;
          return;
        }

        if (stagedSaveId) {
          const wanted = stagedSaveId;
          // Once. A reconnect must not rewind the game - the same rule the
          // flat path states about `resumeSaveId`.
          stagedSaveId = null;
          awaitSave(roomId, wanted, (bytes) => core.loadState(bytes));
        }

        /*
         * The one resume attempt this session gets, and why it lives here
         * rather than at the click that led to `launch()`: `audio` does not
         * exist yet on a first launch at that point, and holds the PREVIOUS
         * session's closing context on a relaunch. Here it is the context
         * this launch just started via `audio.start()` (inside
         * `createSoloEngine` above), and the XR select that led to this call
         * is as close to a user gesture as this session will ever get.
         *
         * This is very likely a no-op: the document already has sticky
         * activation from the DOM click that entered VR in the first place,
         * so the context should already be `running`. If it is not - some
         * browser did not count the XR select - there is deliberately no
         * in-world prompt for it: a `needsAudioGesture` flag used to zero
         * `pad1` while this was pending and re-fire `resume()` every frame
         * with nothing drawn anywhere to explain why the controller had gone
         * dead - unreachable in practice, and worth deleting rather than
         * building a screen for. The game plays muted instead, and this is
         * the one place that says so, once.
         */
        await audio.resume();
        if (audio.needsGesture) {
          logger.warn('audio context still suspended after resume; game will run muted');
        }

        // The screen becomes a picture again, so it must stop being a
        // pointer target - `scene.aimedAt` holds this same `regions` array.
        launchFor = null;
        scene.screen.regions.length = 0;
        // The new engine's first frame needs the screen back; `upload` will
        // not take it by itself any more.
        scene.screen.showPicture();
        scene?.panelsVisible(false);
        engine.governor.start();
        // So `resume` is there next time the panels come back, even though
        // they are hidden right now and the paint itself is invisible.
        repaintProfile();
      } catch (err) {
        // `loadCore()` and `createSoloEngine()` were unguarded here: a
        // rejection from either used to be an unhandled promise rejection
        // with no console in the headset, no `launchNotice`, and no cleanup -
        // the panel just sat there, unrepainted and unexplained.
        // `SoloRoom.svelte`'s flat boot catches the same failure class; this
        // is its VR shape.
        logger.error('vr engine failed to start', err);
        launchNotice = t($language, 'vrLaunchFailed');
        repaintLibrary();
        void engine?.stop();
        engine = null;
        void audio?.stop();
        audio = null;
        giveUpRoom();
      }
    } finally {
      launching = false;
    }
  }

  /** The session's own visibility, which is what `readVrPad` gates on. */
  function sessionVisibility(): string {
    return session?.session.visibilityState ?? 'hidden';
  }

  /**
   * The staged save, asked for once and waited on for a bounded time.
   *
   * A one-shot listener that removes itself inside its own handler leaks
   * whenever the handler never runs - a save id the server no longer has, a
   * room already gone, a dropped packet - and this socket outlives the VR
   * session, so the leak outlives it too. Two relaunches would then leave two
   * closures, and a late reply would apply a save to a core whose engine has
   * already been stopped. `readRoomSram` bounds its own one-shot for exactly
   * this reason; this one now does the same, and `teardown` takes it off on
   * the way out.
   *
   * `apply` is a parameter rather than a hardcoded `core.loadState` because
   * solo and a group game disagree on what "loading a save" means once a
   * session exists: solo owns the only core there is, but in lockstep only
   * the host may act on the reply - the guest's copy is meant to arrive as an
   * ordinary resync over the netplay protocol instead (`resume-save.ts`
   * states the rule; `onSessionEvent`'s `'state'` case is where the group
   * caller lives).
   */
  function awaitSave(
    roomId: string,
    saveId: string,
    apply: (bytes: Uint8Array, name?: string) => void
  ): void {
    const sock = $socket;
    if (!sock) return;

    dropSaveListener();
    saveTimer = setTimeout(() => {
      dropSaveListener();
      logger.warn('vr save load never answered', { roomId, saveId });
    }, 5000);

    saveListener = (payload: { saveData?: string; name?: string }) => {
      dropSaveListener();
      if (!payload?.saveData) return;
      try {
        apply(fromBase64(payload.saveData), payload.name);
      } catch (err) {
        logger.error('vr could not decode the save', err);
        launchNotice = t($language, 'vrLaunchFailed');
        repaintLibrary();
      }
    };
    sock.on('game:loaded', saveListener);
    sock.emit('game:load', { roomId, saveId });
  }

  /** Taken off in `teardown`: the socket outlives the session. */
  let rejoinRoom: (() => void) | null = null;

  /** Held at component scope so `teardown` can take it off the shared socket. */
  let saveListener: ((payload: { saveData?: string; name?: string }) => void) | null = null;
  /**
   * Held beside it, and cleared by the same function.
   *
   * A local `const` was unreachable from `teardown`, and a superseded
   * `awaitSave` left the old one armed - five seconds later it dropped the
   * NEW listener while logging the old save's id.
   */
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function dropSaveListener(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!saveListener) return;
    $socket?.off('game:loaded', saveListener);
    saveListener = null;
  }

  function readRoomSram(roomId: string): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      const sock = $socket;
      if (!sock) return resolve(null);
      const timer = setTimeout(() => { sock.off('game:sramLoaded', done); resolve(null); }, 5000);
      function done(data: { sramData: string | null }) {
        sock!.off('game:sramLoaded', done);
        clearTimeout(timer);
        try {
          resolve(data.sramData ? decodeSram(data.sramData) : null);
        } catch {
          // A save that will not decode is not a save. Starting fresh beats
          // refusing to start.
          resolve(null);
        }
      }
      sock.on('game:sramLoaded', done);
      sock.emit('game:loadSram', { roomId });
    });
  }

  function onGameStarted(): void {
    const room = $myRoom;
    if (!room || room.players.length < 2 || !room.gameCrc32) return;
    // A game already running here is the relaunch case, which `launch` guards.
    if (engine) return;
    void launchTogether(room.id, room.gameCrc32, room.hostId === $user?.id);
  }

  async function launchTogether(roomId: string, crc32: string, isHost: boolean): Promise<void> {
    if (launching) return;
    launching = true;
    // Built before the engine exists to own it, so it is this function's own
    // job to close it on every path that abandons it before that handoff -
    // see the two `transport.close()`/`transport?.close()` calls below.
    let transport: Transport | null = null;
    try {
      /*
       * D6: lockstep, and lockstep only.
       *
       * A creator who set streaming or dual from the flat page would
       * otherwise hand a VR peer a `LockstepEngine` built against a
       * `P2PRoom` on the other end - a session with nothing to talk to,
       * failing in mutual silence rather than a stated refusal.
       *
       * `emulationMode` is not in `my-room.ts`'s `RoomView` - round A left it
       * out of the store's type - but `toPublicRoom` (backend) always sends
       * it, on every `room:update`, so it is on the wire and this reads it
       * with a local cast rather than widening a file outside this fix's
       * scope.
       */
      const mode = $myRoom?.emulationMode;
      if (mode && mode !== 'lockstep') {
        // Refused locally, not on the server: the room's game is left alone
        // rather than released, because a mode of streaming or dual is
        // exactly the shape a flat `P2PRoom` on the other end is built to
        // run, and releasing it here could kill a game that is working fine
        // for them.
        launchNotice = t($language, 'vrModeNotLockstep');
        scene?.panelsVisible(true);
        repaintLibrary();
        return;
      }

      // Lets one query pull both players' lines for the same match, exactly
      // as `LockstepRoom.svelte`'s own `boot()` does - the one label the solo
      // path (`launch()` above) has no use for, since it plays alone.
      setLogLabels({ roomId, player: isHost ? 'p1' : 'p2' });

      const rom = await resolveQuietly(crc32, { requestPermission: false });
      if (!rom) {
        // The refusal the launch screen already predicted. Saying it twice is
        // better than a black screen.
        launchNotice = t($language, 'vrRomMissing');
        scene?.panelsVisible(true);
        repaintLibrary();
        return;
      }

      const core = await loadCore();
      audio = new AudioSink();

      // By path, not through the barrel: it reaches `simple-peer` and
      // `import.meta.env`, exactly as `LockstepRoom.svelte` notes.
      const { ZnetWebRtcTransport } = await import('$lib/znet/webrtc-transport');
      const relay = new SocketTransport($socket as never, roomId);
      transport = new UpgradingTransport(
        relay,
        new ZnetWebRtcTransport($socket as never, roomId, isHost)
      );

      if (!scene) {
        transport.close();
        void audio.stop();
        audio = null;
        return;
      }

      // Snapshotted for `onSessionEvent` and `awaitSave`'s reply, which run
      // outside this function's closure - see the header on the `let`s
      // themselves. `resumeSaveToRequest` is the same rule `LockstepRoom.svelte`
      // follows: null for a guest, who never asks and would discard its own
      // reply anyway (`resume-save.ts`).
      groupRoomId = roomId;
      groupIsHost = isHost;
      pendingResumeSaveId = resumeSaveToRequest($myRoom, $myRoom?.createdBy === $user?.id, null);

      engine = await createLockstepEngine({
        core,
        rom,
        isHost,
        transport,
        sram: {
          load: () => readRoomSram(roomId),
          save: (bytes) => $socket?.emit('game:saveSram', { roomId, sramData: toBase64(bytes) })
        },
        audio,
        joinRelay: () => joinRelay(roomId),
        // One mask, which is what `readVrPad` already produces - no `pad2: 0`
        // here, because the other pad arrives over the transport.
        readLocalInput: () =>
          scene && !scene.arePanelsVisible()
            ? readVrPad(scene.inputSources(), padMap, sessionVisibility())
            : 0,
        onEvent: onSessionEvent,
        onFrame: (c) => scene?.screen.upload(c.videoSurface()),
        onError: (err) => logger.error('vr lockstep', err),
        schedule: scene.schedule
      });

      /*
       * The session may have died while the relay handshake was in flight.
       *
       * `createLockstepEngine` awaits the ROM, the audio device, the cartridge
       * save and the relay - and a headset put down at any of them runs
       * `onDestroy` -> `closeAnySession()`, which nulls `scene`, `engine` and
       * `audio`. The pending promise then resolves onto a corpse and, without
       * this, reassigns `engine`, starts a governor and arms a thirty-second
       * SRAM timer that nothing is left to stop. `scene` being null is the
       * signal, exactly as the solo path reads it above.
       */
      if (!scene) {
        void engine.stop();
        engine = null;
        groupRoomId = null;
        groupIsHost = false;
        pendingResumeSaveId = null;
        giveUpRoom();
        void audio?.stop();
        audio = null;
        return;
      }

      await audio.resume();
      launchFor = null;
      scene.screen.regions.length = 0;
      scene.screen.showPicture();
      scene?.panelsVisible(false);
      // The engine does not start its own governor - `solo-engine.ts` does not
      // either, and `SoloRoom.svelte`'s own `boot()` and this file's `launch()`
      // above are where the flat and solo paths start theirs: starting it
      // inside the engine reaches `requestAnimationFrame`, which does not
      // exist under the node test runner.
      engine.governor.start();
      repaintProfile();
    } catch (err) {
      logger.error('vr lockstep failed to start', err);
      launchNotice = t($language, 'vrLaunchFailed');
      scene?.panelsVisible(true);
      repaintLibrary();
      transport?.close();
      void engine?.stop();
      engine = null;
      groupRoomId = null;
      groupIsHost = false;
      pendingResumeSaveId = null;
      void audio?.stop();
      audio = null;
    } finally {
      launching = false;
    }
  }

  /** Emits `znet:join` and resolves on `znet:joined`, with the same ten-second
   * ceiling the flat path uses. */
  function joinRelay(roomId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = $socket;
      if (!sock) return reject(new Error('Not connected to the server'));
      const timer = setTimeout(() => {
        sock.off('znet:joined', onJoined);
        reject(new Error('The server did not confirm the netplay session'));
      }, 10000);
      const onJoined = () => {
        clearTimeout(timer);
        sock.off('znet:joined', onJoined);
        resolve();
      };
      sock.on('znet:joined', onJoined);
      sock.emit('znet:join', { roomId });
    });
  }

  /**
   * A mid-game notice, painted where it can actually be seen.
   *
   * There is no HUD over the running picture: `frame()` reads
   * `scene.arePanelsVisible()` to decide whether the trigger is a pointer or
   * the SNES R button, and both `readVrPad` call sites zero the pad while the
   * panels are up - so forcing them up for a transient `desync` or
   * `link-lost` would silently take the controller away mid-play, which is a
   * worse surprise than the notice it would carry. Painted onto the library
   * band instead, unseen until the player raises the panels on their own
   * (the menu button, or `vrResume`'s own screen) to check on the game - at
   * which point it is already there instead of needing another frame to
   * catch up.
   *
   * Localised through `NOTICE_FOR` below: it composed
   * `${event.type}: ${event.message}` at first, so a player read "link-lost"
   * off a two-and-a-half-metre screen. The event names belong in the log,
   * which `onSessionEvent` already writes.
   */
  function noteOnLibrary(event: SessionEvent): void {
    /*
     * A sentence, not an identifier.
     *
     * This composed `${event.type}: ${event.message}` - so a player read
     * "link-lost" off a two-metre screen. The event names are for the log,
     * which `onSessionEvent` already writes; what reaches the band has to say
     * what happened and whether to wait.
     */
    launchNotice = t($language, NOTICE_FOR[event.type] ?? 'vrLaunchFailed');
    repaintLibrary();
  }

  /** Only the three the player can act on; the rest never reach the band. */
  const NOTICE_FOR: Partial<Record<SessionEvent['type'], 'vrDesync' | 'vrLinkLost' | 'vrLinkRestored'>> = {
    desync: 'vrDesync',
    'link-lost': 'vrLinkLost',
    'link-restored': 'vrLinkRestored'
  };

  /**
   * Puts the curved screen back on something a player can act on, instead of
   * leaving a dead game's last frame up front and centre.
   *
   * Reopens the launch screen for the room's own game when the library still
   * has it - the same options screen `repaintLaunch` would have shown before
   * the game started - and falls back to the test pattern otherwise, exactly
   * as `repaintLaunch` itself does when a dump leaves the library mid-session.
   */
  function backToLaunchScreen(): void {
    // The screen carries one thing. Whoever asks for the launch options gets
    // them, and the remap panel stands down rather than leaving its regions on
    // a mesh that is drawing something else.
    remapOpen = false;
    listeningFor = null;
    const crc32 = $myRoom?.gameCrc32 ?? null;
    if (crc32 && entryFor(crc32)) {
      launchFor = crc32;
      repaintLaunch();
      return;
    }
    launchFor = null;
    if (scene) {
      scene.screen.regions.length = 0;
      scene.screen.showTestPattern();
    }
  }

  /** The whole session event surface: covers every member of `SessionEvent`'s
   *  `type` union, and none may be silent - see `session.ts` for what each
   *  one means. */
  function onSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'state':
        logger.info('vr session', event);
        // Once, and only here: 'running' comes back after every resync too,
        // and re-sending this would rewind a match that had already moved on
        // - `LockstepRoom.svelte`'s own handler states the same rule for the
        // flat path's `resumeSaveId`.
        if (event.message === 'running' && pendingResumeSaveId && groupRoomId) {
          const wanted = pendingResumeSaveId;
          pendingResumeSaveId = null;
          const applyingHost = groupIsHost;
          awaitSave(groupRoomId, wanted, (bytes, name) => {
            // D5: only the host adopts and reseeds the session; the guest
            // gets the change as an ordinary resync over the netplay
            // protocol, exactly like `LockstepRoom.svelte`'s `onSaveLoaded`.
            if (!applyingHost) return;
            (engine as LockstepEngine | null)?.adoptState(bytes, `save "${name ?? ''}"`);
          });
        }
        break;
      case 'resync-start':
      case 'resync-done':
      case 'peer-ready':
      case 'rtt':
        logger.info('vr session', event);
        break;
      case 'desync':
      case 'link-lost':
        logger.warn('vr session', event);
        noteOnLibrary(event);
        break;
      case 'link-restored':
        logger.info('vr session', event);
        noteOnLibrary(event);
        break;
      case 'error':
        logger.error('vr session', event);
        /*
         * An `error` is not always a death.
         *
         * `fail()` sets the session to `'failed'`; a savestate that will not
         * load reports `error` and leaves it running - and that second path
         * is reachable only through the resume this feature added. Ending the
         * game on it would cost the FRIEND their session over a save that
         * merely did not apply, which the flat twin does not do: it shows the
         * text and plays on.
         */
        if (engine && (engine as LockstepEngine).session?.state !== 'failed') {
          noteOnLibrary(event);
          scene?.panelsVisible(true);
          break;
        }
        // Back to the screen that can explain itself, rather than a picture
        // that has stopped moving for no stated reason - `stopTogether`
        // below is what actually puts it there.
        launchNotice = t($language, 'vrLaunchFailed');
        void stopTogether();
        break;
      default: {
        /*
         * An exhaustiveness assertion, not a catch-all.
         *
         * Carrying no `default` at all would not protect this switch: a
         * statement switch with no return is not exhaustiveness-checked, so
         * an unhandled member would silently do nothing - which is what
         * `LockstepRoom.svelte`'s own handler does today with three of the
         * nine.
         *
         * Assigning the narrowed value to `never` is what makes the compiler
         * name the member nobody handled.
         */
        const unhandled: never = event.type;
        logger.warn('vr session event nobody handles', { type: unhandled });
        break;
      }
    }
  }

  /**
   * Ends the game and stays in VR.
   *
   * Two callers, and they are not the same kind of event. `onSessionEvent`
   * reaches here after reporting `error`, and the profile band's `stop` button
   * reaches here because the player asked. The work is identical either way -
   * release the engine, give the room its game back, raise the panels, put the
   * curved screen back on the launch options - so it is one function rather
   * than two that must be kept in step.
   *
   * Deliberately NOT `leave()`: that ends the `XRSession` and drops the player
   * out of the headset. Until this button existed that was the only way out of
   * a running game, because the launch screen only exists while no game holds
   * the screen - so choosing a second game meant leaving VR and coming back.
   *
   * Raises the panels, because the library's notice band that carries the
   * error message is invisible while `panelsVisible` is false, and puts the
   * curved screen itself back on the launch options rather than leaving the
   * dead game's last frame up front and centre - see `backToLaunchScreen`.
   * A session-level `error` is treated as fatal to the game for both
   * players, not just this one: the same lockstep session is what just broke,
   * so `giveUpRoom` releases the room's game rather than only this seat - see
   * its own header for the full reasoning. A deliberate stop wants the same
   * thing for a different reason: the player leaving is one of the two the
   * game needs, so there is no game left to hand back to.
   *
   * Safe in solo, where `giveUpRoom` emits nothing: it is guarded on a room
   * with two players in `playing` status, and solo has no room at all.
   */
  async function stopTogether(): Promise<void> {
    await engine?.stop();
    engine = null;
    void audio?.stop();
    audio = null;
    groupRoomId = null;
    groupIsHost = false;
    pendingResumeSaveId = null;
    giveUpRoom();
    scene?.panelsVisible(true);
    backToLaunchScreen();
    repaintLibrary();
    repaintProfile();
  }

  /**
   * The other side of a group game ending: the friend released it (their own
   * quit button or pause menu, from the flat page), and the server has
   * already told the whole room by the time this fires.
   *
   * Local cleanup only. Unlike `stopTogether`, this never calls `giveUpRoom`
   * - nothing here decided to end the game, so there is nothing to give back
   * that the other player has not already taken care of - and it never
   * touches the socket. Guarded on `engine` so the echo of this player's own
   * `room:release-game` (see `giveUpRoom`) is a safe no-op: `teardown` and
   * `stopTogether` both null `engine` before they can cause that echo.
   */
  function onGameStopped(): void {
    if (!engine) return;
    void engine.stop();
    engine = null;
    void audio?.stop();
    audio = null;
    groupRoomId = null;
    groupIsHost = false;
    pendingResumeSaveId = null;
    scene?.panelsVisible(true);
    backToLaunchScreen();
    repaintLibrary();
    repaintProfile();
  }

  function frame(): void {
    if (!scene) return;

    /*
     * A capture in progress owns the controllers, and owns them first.
     *
     * The right stick click CANCELS here instead of recalling the panels: it
     * is the one input outside the model, so it is the only recall a player
     * can have while every other button is capturable. `activeXrInputs`
     * deliberately never reports it, so cancelling cannot also be captured.
     *
     * Nothing else runs this frame - no pointer, no hover - because the panel
     * carries no regions while it listens.
     */
    if (remapOpen && listeningFor) {
      const sources = scene.inputSources();
      if (menuPressed(sources)) {
        listeningFor = null;
        captureGate.reset();
        repaintControls();
        return;
      }
      /*
       * The cast is sound, and narrow.
       *
       * `CaptureGate` speaks plain strings - it is shared with the flat
       * screen, whose codes are keyboard and standard-pad codes. The only
       * thing this call ever hands it is `activeXrInputs`' output, so the only
       * thing it can hand back is one of those.
       */
      const taken = captureGate.tick(activeXrInputs(sources)) as XrInput | null;
      if (taken) {
        padMap = assignInput(padMap, listeningFor, taken);
        writePadMap(localStorage, padMap);
        // Read back for the same reason the presets are: `readPadMap` is the
        // only thing that decides, and the default is removed rather than
        // stored - so a map that happens to equal it must still read back.
        padMap = readPadMap(localStorage);
        listeningFor = null;
        repaintControls();
        repaintProfile();
      }
      return;
    }

    if (menuPressed(scene.inputSources())) scene.panelsVisible(true);

    /*
     * The panels and the game never read the controllers at the same time.
     * The trigger is the pointer while the panels are up and SNES R while they
     * are down, and letting both read it would make a scroll press jump in
     * Super Mario World.
     */
    if (!scene.arePanelsVisible()) return;

    const tick = pointer.update(scene.aimedAt(), scene.triggerDown());
    if (!sameTarget(tick.hover, hovered)) {
      const before = hovered;
      hovered = tick.hover;
      // Only the panels whose hover actually changed: a panel repaint is a
      // canvas rasterise, and doing it for all three every hover tick would
      // cost more, at 72 Hz, than the emulator itself.
      for (const panel of new Set([before?.panel, hovered?.panel])) {
        if (panel === 'library') repaintLibrary();
        if (panel === 'friends') repaintFriends();
        if (panel === 'profile') repaintProfile();
        if (panel === 'screen') {
          if (remapOpen) repaintControls();
          else repaintLaunch();
        }
      }
    }
    if (tick.activated) activate(tick.activated);
  }

  /*
   * Named consts, registered in `enter()` below and unregistered with the
   * SAME references in `teardown()`. `FriendsList.svelte` binds these same
   * two socket.io events on the same socket and stays mounted across a VR
   * session; in socket.io v4 `off(event)` with no handler argument removes
   * EVERY listener for that event, not just this component's, so a bare
   * `$socket?.off('friends:online')` here used to also strip `FriendsList`'s
   * listener - it kept rendering, just never updating again, which pointed
   * nowhere near VR as the cause.
   */
  function handleFriendsOnline(list: Array<{ id: string; online: boolean }>): void {
    onlineFriends = new Map(list.map((f) => [f.id, f.online]));
    repaintFriends();
  }

  function handleFriendStatusChanged({ userId, online }: { userId: string; online: boolean }): void {
    // Reassigned, not mutated in place: `onlineFriends` is only read through
    // the explicit `repaintFriends()` call below today, but a `.set()` with
    // no reassignment is invisible to Svelte's reactivity, and
    // `handleFriendsOnline` above already reassigns - keeping both handlers in
    // that shape means neither can quietly become the one Svelte can't see.
    onlineFriends = new Map(onlineFriends).set(userId, online);
    repaintFriends();
  }

  async function enter(): Promise<void> {
    if (session) return;
    try {
      // Read once per session, into the plain `let` above - see its comment
      // for why this cannot be a reactive statement.
      padMap = readPadMap(localStorage);

      scene = createVrScene({
        aspect: readAspectPreference(localStorage),
        onContextLost: () => {
          logger.warn('the XR webgl context was lost');
          // `show(message, type)` — the store has no `.error()` helper
          // (`services/notification.ts:16`), and a 6 s duration because this
          // one lands on the flat page the player has just been dropped onto.
          notifications.show(t($language, 'vrContextLost'), 'error', 6000);
          void leave();
        },
        // The one witness to a throw out of the XR animation loop. Without it
        // the loop's own guard would keep the world drawable and tell nobody
        // why the game had stopped.
        onFrameError: (err) => logger.error('vr frame', err)
      });

      session = await openVrSession(() => {
        // The single exit. Not `leave()`: the session is already over, and
        // asking it to end again would be the second call this guards against.
        void teardown();
      });

      await scene.attach(session.session as unknown as XRSession);

      /*
       * Armed as early as they can be, not after the panels and the friends
       * fetch below - `frame()` and `vrActive` used to be the LAST two
       * statements of this function, after an unbounded `fetch`. Until they
       * ran: `frame()` did not exist, so nothing on any panel could respond,
       * including the quit region - `profile.ts`'s header calls that the
       * only exit this app offers - and `vrActive` was still false, so the
       * `room:opened` guard at `+layout.svelte:62` was not yet in place for a
       * partner who chose a game during that window.
       *
       * Safe this early: `frame()` reads `library`, `friendsPanel` and
       * `profilePanel`, all still null below, and the repaint calls it can
       * reach already guard on that (`if (!library) return;` and its
       * siblings). `scene.arePanelsVisible()` defaults true with no panels
       * added yet, `aimedAt()` raycasts against an empty mesh list and
       * returns null, and `sameTarget(null, null)` is true - so a frame here
       * finds nothing to do rather than throwing on it.
       */
      scene.onFrame(frame);
      vrActive.set(true);

      // Until a game is launched, this is what the screen carries - and what
      // makes a wrong distance or height obvious.
      scene.screen.showTestPattern();

      library = scene.addPanel('library', scene.layout.library, LIBRARY_PANEL_SIZE);
      resolvable = await resolvableHere();
      libraryState = {
        // `deviceLibrary()` deliberately keeps an entry with no `crc32` - see
        // its own header - because the flat library is where that game gets
        // an identity. There is no identify flow in here (no file picker to
        // launch it from), so that same entry would otherwise become a
        // `game:<id>` tile that highlights and swallows the press without
        // ever launching anything - `panels/library.ts`'s own comment on
        // `layoutLibraryPanel` calls that worse than not listing it at all.
        // Filtered here, not in `deviceLibrary()`, so the flat library keeps
        // offering to identify these; VR just does not list what it cannot
        // act on.
        games: deviceLibrary($games, resolvable).filter((game) => Boolean(game.crc32)),
        ownedTotal: $games.length,
        scroll: 0
      };
      loadCovers(libraryState.games);
      repaintLibrary();

      friendsPanel = scene.addPanel('friends', scene.layout.friends, FRIENDS_PANEL_SIZE);
      try {
        // Bounded the same way `readRoomSram` bounds its own round trip
        // below: a network stall here is the same class of problem the
        // reordering above just fixed for `frame()` and `vrActive` - an
        // await with no ceiling holding something armed for however long it
        // takes, except this one still had no ceiling at all.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await fetch('/api/friends', {
            credentials: 'include',
            signal: controller.signal
          });
          if (res.ok) friendEntries = await res.json();
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        // A shopfront that failed to load is a shopfront that says "no
        // friends yet". Nothing here is worth ending a session over.
        logger.warn('friends could not be loaded for VR', err);
      }
      $socket?.on('friends:online', handleFriendsOnline);
      $socket?.on('friend:statusChanged', handleFriendStatusChanged);
      $socket?.emit('friends:getOnlineStatus');
      repaintFriends();

      // Neither player's press is the trigger: the room answers `game:started`
      // to both members once either of them asks, and `onGameStarted` reads
      // `$myRoom` fresh rather than trusting anything carried on the event.
      $socket?.on('game:started', onGameStarted);
      // The friend's own quit reaches this listener the same way - the only
      // path that can tell the *other* player of a netplay room the match is
      // over, exactly as `room-session.ts` states for the flat page.
      $socket?.on('game:stopped', onGameStopped);

      /*
       * `game:started` and `game:stopped` are room-channel events, and
       * `socket.join(room.id)` only ever happens in `room:create` and
       * `joinRoom` (`room:join`'s handler) - never on its own for a socket
       * that reconnects. A VR player who reloads, or opens a fresh tab, then
       * enters VR while already in a group is on a socket the room channel
       * has never seen, exactly the gap the flat room page closes by
       * emitting this on every mount. Without it, pressing Launch here gets
       * `game:start` accepted server-side with nobody left to hear the
       * `game:started` that was supposed to build the engine.
       */
      if ($myRoom) $socket?.emit('room:join', { roomId: $myRoom.id });
      /*
       * And again on every reconnect, which `rooms/room-session.ts:75` calls
       * mandatory in as many words: the socket comes back on its own, but
       * `room:join` does not replay itself. Without this a blip mid-session
       * drops channel membership for good - after which `game:started` and
       * `game:stopped` never arrive again, so a friend's quit leaves the
       * frozen picture this feature spent two rounds removing.
       */
      rejoinRoom = () => {
        const room = get(myRoom);
        if (room) $socket?.emit('room:join', { roomId: room.id });
      };
      $socket?.on('connect', rejoinRoom);

      profilePanel = scene.addPanel('profile', scene.layout.profile, PROFILE_PANEL_SIZE);
      repaintProfile();
    } catch (err) {
      logger.error('entering VR failed', err);
      notifications.show(t($language, 'vrUnavailable'), 'error', 6000);
      // Not `teardown()`: `openVrSession` may already have resolved before
      // `scene.attach` (or anything after it) threw, in which case the
      // browser's `XRSession` is still open and `teardown()` would only make
      // the app forget it exists. `closeAnySession()` is safe either way.
      closeAnySession();
    }
  }

  async function leave(): Promise<void> {
    if (leaving) return;
    leaving = true;
    try {
      await session?.end();
      // `end()` raises `sessionend`, which runs `teardown`. Nothing more here.
    } finally {
      leaving = false;
    }
  }

  /**
   * Safe from either precondition: ends a session if one is open, which
   * raises `sessionend` and drives `teardown()` through the `onEnd` callback
   * above; tears down directly, with nothing to end, if not.
   *
   * Used at the two sites that cannot promise the session is already closed -
   * a failure partway through `enter()`, and an ordinary Svelte unmount. The
   * component's own invariant is never to be unmounted by navigation, but
   * `onDestroy` still fires on the paths that ignore that invariant, dev-mode
   * HMR chief among them, so it has to go through here rather than straight to
   * `teardown()`.
   */
  function closeAnySession(): void {
    if (session) {
      void leave();
    } else {
      void teardown();
    }
  }

  /**
   * Hands the room back.
   *
   * Called from every path that ends a game without another taking its place:
   * the ordinary exit, a session that died mid-launch, a launch whose engine
   * never started, and a lockstep session `onSessionEvent` gave up on. NOT
   * from the relaunch guard - `createRoom` has already run there, and the
   * server dropped the old room when it did. NOT from `onGameStopped` either
   * - that path did not decide to end the game, the other player did, and
   * there is nothing left here to give back.
   *
   * Two different ways to give a room back, chosen deliberately rather than
   * one applied everywhere.
   *
   * A room this shell created for itself (`ownedRoomId`, solo only) is given
   * up for real, through `leaveGroup`'s `room:leave` - a solo room only ever
   * has one member, so leaving it and destroying it are the same act.
   *
   * A group's room is never left this way. `room:leave` is, in the flat
   * lobby's own words, "what dissolves a group of two" - exactly what
   * quitting a shared GAME must not do. The flat lobby's quit button and its
   * pause-menu twin (`+page.svelte`'s `releaseGame`, `LockstepRoom.svelte`'s
   * `quitToLobby`) both emit `room:release-game` instead: the game is
   * detached, the room and its membership survive, and the friend keeps
   * their seat to pick another game together. Ending a VR player's group
   * game the harsher way, for no reason tied to VR at all, would be a worse
   * exit than the same action already takes on the flat page - so this
   * mirrors `room:release-game` for the group case too.
   *
   * Silent when there is nothing owed, so it is safe to call twice.
   */
  function giveUpRoom(): void {
    if (ownedRoomId) {
      leaveGroup(ownedRoomId);
      ownedRoomId = null;
      return;
    }

    const room = $myRoom;
    if (room && room.players.length >= 2 && room.status === 'playing') {
      $socket?.emit('room:release-game', { roomId: room.id });
    }
  }

  /** Assumes the browser's `XRSession` is already gone. Only `onEnd` above may
   * call this directly - every other exit goes through `closeAnySession()`. */
  async function teardown(): Promise<void> {
    // First, and awaited: it stops the governor and writes the cartridge save
    // one last time, before audio and the scene it renders into are torn down
    // out from under it. `core` needs no line here - it never lived in this
    // component's state, only the engine's own closure, which `engine.stop()`
    // already released.
    await engine?.stop();
    engine = null;
    groupRoomId = null;
    groupIsHost = false;
    pendingResumeSaveId = null;
    // After the engine, so the last cartridge save is written while the room
    // that stores it still exists.
    giveUpRoom();
    // Closes the AudioContext rather than just dropping the reference - the
    // same leak the relaunch guard in `launch()` closes on its own path, but
    // this is the ordinary one: every session that ever launched a game
    // takes it.
    void audio?.stop();
    audio = null;
    scene?.dispose();
    scene = null;
    session = null;
    library = null;
    // The same references `enter()` registered - see the comment above
    // `handleFriendsOnline` for why a bare `off(event)` is not safe here.
    $socket?.off('friends:online', handleFriendsOnline);
    $socket?.off('friend:statusChanged', handleFriendStatusChanged);
    $socket?.off('game:started', onGameStarted);
    $socket?.off('game:stopped', onGameStopped);
    friendsPanel = null;
    friendEntries = [];
    onlineFriends = new Map();
    profilePanel = null;
    covers.clear();
    saveShots.clear();
    remapOpen = false;
    listeningFor = null;
    captureGate.reset();
    hovered = null;
    pointer = createPointer();
    launchNotice = null;
    // Left set, a quit from the launch screen would show it again on the very
    // next session's screen before anything was clicked - `scene` is fresh,
    // but this `let` is component state and outlives the session that set it.
    launchFor = null;
    stagedSaveId = null;
    // The shared socket outlives this session; a listener left on it would
    // fire against a core that no longer has an engine.
    dropSaveListener();
    if (rejoinRoom) {
      $socket?.off('connect', rejoinRoom);
      rejoinRoom = null;
    }
    vrActive.set(false);
    vrRequested.set(false);
  }

  // The button sets the store; this is the one place that acts on it.
  $: if ($vrRequested && !session) void enter();

  onDestroy(closeAnySession);
</script>

<!-- Nothing is rendered: the whole surface of this component is the headset.
     The renderer's canvas is detached on purpose - it is never displayed on the
     flat page, and inserting it would leave a black rectangle behind the app. -->
