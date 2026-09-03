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
  import { menuPressed, readVrPad } from '$lib/vr/pad';
  import { readPadScheme } from '$lib/vr/pad-scheme';
  import { games } from '$lib/stores/games';
  import { deviceLibrary } from '$lib/roms/device-library';
  import { resolvableHere, resolveQuietly } from '$lib/roms/provider';
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
  let hovered: PointerTarget | null = null;
  /** Read once on entry: the picker that would change it does not exist in
   *  here, so it cannot change during a session. */
  let resolvable: string[] = [];

  let engine: SoloEngine | null = null;
  let core: PsnesCore | null = null;
  let audio: AudioSink | null = null;
  let needsAudioGesture = false;
  /** Shown on the lectern when a launch could not read the file. */
  let launchNotice: string | null = null;
  $: padScheme = readPadScheme(localStorage);

  /** Covers are same-origin behind the session cookie (`api/covers.ts:9`), so
   *  they load with no crossOrigin attribute - setting one would break the
   *  cookie AND taint the canvas, and a tainted canvas cannot become a WebGL
   *  texture at all. */
  const covers = new Map<string, CanvasImageSource>();

  function repaintLibrary(): void {
    if (!library) return;
    library.regions = layoutLibraryPanel(libraryState);
    const regions = library.regions;
    library.paint((ctx) =>
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
      })
    );
    const notice = launchNotice;
    if (notice) {
      library.paint((ctx) => {
        ctx.save();
        ctx.fillStyle = '#7a2222';
        ctx.fillRect(0, 0, LIBRARY_PANEL_SIZE.width, 40);
        ctx.fillStyle = '#ffffff';
        ctx.font = '18px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(notice, LIBRARY_PANEL_SIZE.width / 2, 20);
        ctx.restore();
      });
    }
  }

  function loadCovers(list: typeof $games): void {
    for (const game of list) {
      if (!game.coverUrl || covers.has(game.id)) continue;
      const image = new Image();
      image.onload = () => { covers.set(game.id, image); repaintLibrary(); };
      image.src = game.coverUrl;
    }
  }

  function activate(target: PointerTarget): void {
    if (target.panel !== 'library') return;
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
      // The gesture that got us here is an XR select, which is as close to a
      // user gesture as this session will ever get - so resume here, where a
      // browser that counts it will let the sound through with no prompt.
      void audio?.resume();
      void launch(target.region.id.slice('game:'.length));
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
       */
      const rom = await resolveQuietly(game.crc32);
      if (!rom) {
        launchNotice = t($language, 'vrRomUnreadable');
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
        core = null;
        needsAudioGesture = false;
      }

      try {
        core = await loadCore();
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
          core = null;
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
            // Zero while the panels are up (the trigger is the pointer then)
            // and zero while a gesture is pending (the trigger press that
            // unlocks audio must not also register as SNES R) - both gate the
            // same physical button so a single press never means two things.
            pad1: scene && !scene.arePanelsVisible() && !needsAudioGesture
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

        // `needsGesture` is a question, not an assumption - `output.ts:199` records
        // what happened to the caller who assumed otherwise. An XR `select` may or
        // may not count as user activation, so the in-world prompt is the designed
        // answer rather than a hope.
        needsAudioGesture = audio.needsGesture;

        scene?.panelsVisible(false);
        engine.governor.start();
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
        core = null;
        needsAudioGesture = false;
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

    // A player who has to press once for sound presses the trigger, which is
    // also SNES R. This is the same physical button `readPads` above already
    // zeroes for while `needsAudioGesture` is true, so this press resumes
    // audio and does nothing in-game until it resolves.
    if (needsAudioGesture && scene.triggerDown()) {
      void audio?.resume();
      needsAudioGesture = audio?.needsGesture ?? false;
    }

    /*
     * The panels and the game never read the controllers at the same time.
     * The trigger is the pointer while the panels are up and SNES R while they
     * are down, and letting both read it would make a scroll press jump in
     * Super Mario World.
     */
    if (!scene.arePanelsVisible()) return;

    const tick = pointer.update(scene.aimedAt(), scene.triggerDown());
    if (!sameTarget(tick.hover, hovered)) {
      hovered = tick.hover;
      repaintLibrary();
    }
    if (tick.activated) activate(tick.activated);
  }

  async function enter(): Promise<void> {
    if (session) return;
    try {
      scene = createVrScene({
        aspect: readAspectPreference(localStorage),
        onContextLost: () => {
          logger.warn('the XR webgl context was lost');
          // `show(message, type)` — the store has no `.error()` helper
          // (`services/notification.ts:16`), and a 6 s duration because this
          // one lands on the flat page the player has just been dropped onto.
          notifications.show(t($language, 'vrContextLost'), 'error', 6000);
          void leave();
        }
      });

      session = await openVrSession(() => {
        // The single exit. Not `leave()`: the session is already over, and
        // asking it to end again would be the second call this guards against.
        void teardown();
      });

      await scene.attach(session.session as unknown as XRSession, session.spaceType);
      // Until a game is launched, this is what the screen carries - and what
      // makes a wrong distance or height obvious.
      scene.screen.showTestPattern();

      library = scene.addPanel('library', scene.layout.library, LIBRARY_PANEL_SIZE);
      resolvable = await resolvableHere();
      libraryState = {
        games: deviceLibrary($games, resolvable),
        ownedTotal: $games.length,
        scroll: 0
      };
      loadCovers(libraryState.games);
      repaintLibrary();
      scene.onFrame(frame);

      vrActive.set(true);
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
    // one last time, before core, audio and the scene it renders into are torn
    // down out from under it.
    await engine?.stop();
    engine = null;
    core = null;
    // Closes the AudioContext rather than just dropping the reference - the
    // same leak Finding 2's relaunch guard closes on its own path, but this
    // is the ordinary one: every session that ever launched a game takes it.
    void audio?.stop();
    audio = null;
    needsAudioGesture = false;
    scene?.dispose();
    scene = null;
    session = null;
    library = null;
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
