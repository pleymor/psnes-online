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
  import { activeRooms } from '$lib/rooms/my-room';
  import { menuPressed, readVrPad } from '$lib/vr/pad';
  import { readPadScheme, writePadScheme, type VrPadScheme } from '$lib/vr/pad-scheme';
  import { user } from '$lib/stores/user';
  import { games } from '$lib/stores/games';
  import { deviceLibrary } from '$lib/roms/device-library';
  import { resolvableHere, resolveQuietly, type MissReason } from '$lib/roms/provider';
  import type { PanelMesh } from '$lib/vr/panel-mesh';
  import { loadCore, AudioSink } from '$lib/znet';
  import { createSoloEngine, type SoloEngine } from '$lib/rooms/solo-engine';
  import { createRoom } from '$lib/rooms/actions';
  import { decodeSram } from '$lib/rooms/sram';
  import { toBase64 } from '$lib/saves/base64';
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

  let engine: SoloEngine | null = null;
  let audio: AudioSink | null = null;
  /** Shown on the lectern when a launch could not read the file. */
  let launchNotice: string | null = null;
  /**
   * A plain `let`, set once in `enter()` and reassigned by the switch in
   * `activate()` - never `$: padScheme = readPadScheme(localStorage)`. Made
   * reactive, that statement would recompute on the very write it triggers
   * (`writePadScheme` touches `localStorage`) and overwrite the assignment
   * before the panel ever repaints with it - the button would appear to do
   * nothing.
   */
  let padScheme: VrPadScheme = 'letters';

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
      scheme: padScheme,
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

  function loadCovers(list: typeof $games): void {
    for (const game of list) {
      if (!game.coverUrl || covers.has(game.id)) continue;
      const image = new Image();
      // Before `src`, or the attribute does not apply to the request. See the
      // note on `covers` for why this is per-URL rather than always or never.
      if (isForeign(game.coverUrl)) image.crossOrigin = 'anonymous';
      image.onload = () => { covers.set(game.id, image); repaintLibrary(); };
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
        launchNotice = null;
        // Not `void audio?.resume()` here any more: on a first launch `audio`
        // is still null (it is constructed inside `launch()`, several awaits
        // below), and on a relaunch this is the context `launch()` is about to
        // close. `launch()` itself resumes the context it just started, once
        // `audio.start()` has actually run.
        void launch(target.region.id.slice('game:'.length));
      }
      return;
    }

    if (target.panel === 'profile') {
      const id = target.region.id;
      if (id === 'quit') { void leave(); return; }
      if (id === 'resume') { scene?.panelsVisible(false); return; }
      if (id === 'scheme:letters' || id === 'scheme:thumb') {
        const next = id === 'scheme:thumb' ? 'thumb' : 'letters';
        writePadScheme(localStorage, next);
        // Read back rather than assumed: `readPadScheme` is the only thing
        // that decides, and a preset written and not stored (the default is
        // removed, not stored) must still read back correctly.
        padScheme = readPadScheme(localStorage);
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
  }

  /** Guards `launch()` against overlapping itself - the same shape of problem
   *  `leaving` guards `leave()` against. A second trigger press landing while
   *  the first launch is still mid-flight (neither has reached `engine` yet)
   *  would otherwise slip past the `if (engine)` check below and construct
   *  two engines, both handed the same `scene.schedule`. */
  let launching = false;

  async function launch(gameId: string): Promise<void> {
    if (!scene || launching) return;
    const game = libraryState.games.find((candidate) => candidate.id === gameId);
    if (!game?.crc32) return;

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
              ? readVrPad(scene.inputSources(), padScheme, sessionVisibility())
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
      }
    } finally {
      launching = false;
    }
  }

  /** The session's own visibility, which is what `readVrPad` gates on. */
  function sessionVisibility(): string {
    return session?.session.visibilityState ?? 'hidden';
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

  function frame(): void {
    if (!scene) return;

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
      padScheme = readPadScheme(localStorage);

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
    // Closes the AudioContext rather than just dropping the reference - the
    // same leak Finding 2's relaunch guard closes on its own path, but this
    // is the ordinary one: every session that ever launched a game takes it.
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
    friendsPanel = null;
    friendEntries = [];
    onlineFriends = new Map();
    profilePanel = null;
    covers.clear();
    hovered = null;
    pointer = createPointer();
    launchNotice = null;
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
