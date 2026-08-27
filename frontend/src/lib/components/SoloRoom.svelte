<script lang="ts">
  /**
   * Solo play on the znet stack.
   *
   * The same primitives as LockstepRoom, minus everything about a peer: no
   * relay, no transport, no session handshake, no input delay, no resync. What
   * is left is a governor ticking a SoloSession, a renderer, audio, input, and
   * the same save and display chrome the lockstep room has.
   *
   * Solo used to run ClientEmulator on the RetroArch stack, which is why it
   * showed a "LATENCE" panel built for comparing streaming against dual, and
   * why it had none of the toolbar the lockstep room grew.
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { goto } from '$app/navigation';
  import type { ControlsConfig } from '$lib/controls/binding';
  import { createLogger } from '$lib/utils/logger';
  import { fromBase64 } from '$lib/saves/base64';
  import { setLogLabels } from '$lib/utils/log-shipper';
  import { encodeSram, decodeSram } from '$lib/rooms/sram';
  import { applyInputSources } from '$lib/rooms/input-sources';
  import { createRendererSurface, type SurfaceState } from '$lib/rooms/renderer-surface';
  import { createFullscreen } from '$lib/rooms/fullscreen';
  import { socket } from '$lib/api/socket';
  import LocateRom from './LocateRom.svelte';
  import TouchControls from './TouchControls.svelte';
  import { TouchPad, touchPadWanted } from '$lib/controls/touch';
  import { remember, resolveQuietly } from '$lib/roms/provider';
  import { readShaderPreference, writeShaderPreference } from '$lib/stores/shader-preference';
  import PauseMenu from './PauseMenu.svelte';
  import { language } from '$lib/stores/language';
  import { QUICK_SAVE_KEY, QUICK_LOAD_KEY, padUsesKey } from '$lib/saves/quick';
  import { quickSave, quickLoad } from '$lib/saves/quick-actions';
  import { DEFAULT_DISPLAY, type DisplayOptions, type Renderer } from '$lib/znet';
  import {
    AudioSink,
    CanvasRenderer,
    FrameGovernor,
    InputCollector,
    SoloSession,
    PsnesCore,
    loadCore,
    normaliseRom,
    aspectRatioOf,
    fitToBox,
    loadAssignments,
    resolveSources,
    connectedPads,
    isPlayerActive
  } from '$lib/znet';

  export let roomId: string;
  export let gameId: string;
  export let gameCrc32: string | null = null;
  export let gameTitle: string = '';
  export let controls: ControlsConfig;
  /**
   * A save to open on, when the library sent us here to resume one.
   *
   * Asked for once the session is already running, through the same
   * `game:load` the pause menu uses - so there is no second way to apply a
   * savestate, and this cannot get out of step with the one that exists.
   */
  export let resumeSaveId: string | null = null;
  /**
   * Whether this machine may drive port 2 as well.
   *
   * False as soon as anyone else is in the room. The mode a game started in is
   * frozen on purpose - a reconnect must not destroy a running emulator - so a
   * game begun alone keeps running here after someone joins, and port 2 then
   * belongs to *them*. Without this gate the host's second controller drives
   * the other player's character. Reactive, so it also switches back off if a
   * partner returns mid-game.
   */
  export let allowLocalPlayer2 = true;

  const logger = createLogger('SoloRoom');
  const dispatch = createEventDispatcher();

  /**
   * One canvas per context type.
   *
   * A canvas that has produced a webgl2 context can never produce a 2d one, so
   * switching renderers means switching elements. Both live in the markup and
   * one is hidden, which keeps Svelte the owner of both.
   */
  let canvas2d: HTMLCanvasElement;
  let canvasGl: HTMLCanvasElement;
  let usingGl = false;

  let core: PsnesCore | null = null;
  let renderer: Renderer | null = null;
  let surface: ReturnType<typeof createRendererSurface> | null = null;
  let audio: AudioSink | null = null;
  let collector1: InputCollector | null = null;
  let collector2: InputCollector | null = null;
  /**
   * The on-screen controller, for a machine with no keys.
   *
   * Created once and kept for the life of the room even while it is not drawn:
   * the collector holds a reference to it, and swapping the object under the
   * collector every time a controller is plugged in or out would be one more
   * thing to get wrong for no gain.
   */
  const touchPad = new TouchPad();
  let showTouchPad = false;
  let assignments = loadAssignments(localStorage);
  let session: SoloSession | null = null;
  let governor: FrameGovernor | null = null;

  /** Set once the component is gone, so a suspended boot() cannot build on a corpse. */
  let destroyed = false;

  let phase: 'booting' | 'playing' | 'error' = 'booting';
  let statusText = 'Loading emulator core…';
  let errorText = '';
  let needsAudioGesture = false;
  let romPrompt: ((bytes: Uint8Array) => void) | null = null;
  let loadedRom: Uint8Array | null = null;

  let display: DisplayOptions = { ...DEFAULT_DISPLAY };
  let shaderNotice: string | null = null;

  /**
   * Fast-forward, latched from the pause menu.
   *
   * Distinct from `turboHeld` below because the two are different gestures on
   * the same setting, and either one alone must be able to turn it on. The
   * emulator runs fast if either says so; see the `$:` that applies the union.
   */
  let turbo = false;
  /** Fast-forward for as long as a thumb is on the touch pad's button. */
  let turboHeld = false;
  let showPauseMenu = false;
  let pauseRestoresFullscreen = false;
  let isFullscreen = false;
  let sramTimer: ReturnType<typeof setInterval> | null = null;
  let container: HTMLDivElement;

  // Solo has no toolbar to hide and never opens its menu on a fullscreen
  // change we did not ask for, so the deliberate/Escape distinction the
  // module also reports is simply unused here.
  const fullscreen = createFullscreen({
    element: () => container,
    onChange: (active) => {
      isFullscreen = active;
    }
  });

  async function toggleFullscreen(): Promise<void> {
    try {
      await fullscreen.toggle();
    } catch (err) {
      logger.error('Could not toggle fullscreen', err);
    }
  }

  /**
   * Whether the battery save was actually read back from the server.
   *
   * persistSram() refuses to write until this is true. Writing before it
   * would overwrite the player's in-game save with the blank SRAM a
   * freshly-loaded ROM starts with - which is what closing the room during
   * loadSram()'s round trip used to do. A timeout does NOT set this: if we
   * could not read, we must not write, for the whole session.
   */
  let sramLoaded = false;
  let sramNotice: string | null = null;

  /** Shown whenever the battery save could not be read at all - no socket,
   * no core, or no answer from the server in time. Persistence is off for
   * the rest of the session in every one of these cases. */
  const SRAM_UNAVAILABLE_NOTICE =
    'Could not read your battery save from the server; progress will not be saved this session.';
  /** Distinct from SRAM_UNAVAILABLE_NOTICE: here the server did answer, and
   * only decoding its payload failed. "Could not read from the server" would
   * be inaccurate. */
  const SRAM_DECODE_ERROR_NOTICE =
    'Your battery save could not be read; progress will not be saved this session.';

  $: activeCanvas = usingGl ? canvasGl : canvas2d;
  $: displayRatio = aspectRatioOf(display.aspect);
  $: if (renderer && display) {
    renderer.setOptions(display);
    // The pause menu really pauses in solo, so no frame is coming to show the
    // change. Draw one, or every display setting would look inert until resume.
    if (showPauseMenu && core) renderer.draw(core);
  }
  $: if (collector1 && controls) collector1.setControls(controls.p1);
  $: if (collector2 && controls) collector2.setControls(controls.p2);

  /**
   * What the save menus need: a state to store, and the canvas to photograph.
   *
   * `getCanvas` reads `activeCanvas` at call time, so a shader swap between
   * opening the menu and pressing the button still photographs what is on
   * screen.
   */
  $: saveAdapter = core
    ? { saveState: async () => core!.saveState(), getCanvas: () => activeCanvas }
    : null;


  /**
   * Mirrors a renderer-surface change into the plain `let`s Svelte tracks.
   *
   * Must assign these by name rather than hand the surface itself to the
   * template: see the module doc on why it reports through a callback instead
   * of being reactive state.
   */
  function onSurfaceChange(state: SurfaceState): void {
    renderer = state.renderer;
    usingGl = state.usingGl;
    display = { ...display, shader: state.shader };
    shaderNotice = state.notice;
  }

  /**
   * Switches the renderer to run `shaderId`, or keeps 2D and says why.
   *
   * Every failure lands on a working 2D renderer plus a notice. The player is
   * never left looking at a black canvas wondering whether the game crashed.
   */
  async function applyShader(shaderId: string): Promise<void> {
    // Cleared synchronously, same as before the extraction: a stale notice
    // must not sit on screen for the whole length of the shader fetch.
    shaderNotice = null;
    await surface?.apply(shaderId, display);
  }

  /**
   * Takes a display change from the pause menu.
   *
   * A shader change is not just a field: the renderer is built from a compiled
   * preset, so it needs a new renderer entirely. Assigning `display` alone
   * would update the menu's label and change nothing on screen - which is the
   * exact class of defect this branch has already been caught on twice.
   */
  async function onDisplayChange(next: DisplayOptions): Promise<void> {
    const shaderChanged = next.shader !== display.shader;
    display = next;
    if (!shaderChanged) return;

    // Remembered the same way the profile page remembers it.
    writeShaderPreference(localStorage, next.shader);
    await applyShader(next.shader);
  }

  /** Falls back to 2D if the GL context died mid-game. One boolean per slice. */
  function checkRendererHealth(): void {
    surface?.checkHealth(display);
  }

  /**
   * Re-pushes sources into both collectors.
   *
   * Replugging a pad mid-game must be seen: without this, a controller
   * assigned to P2 and replugged would stay silent for the rest of the
   * session.
   */
  function applySources(): void {
    const applied = applyInputSources(localStorage, [collector1, collector2]);
    assignments = applied.assignments;
    // Plugging a controller into a tablet takes the drawn one away, and
    // unplugging it brings it back: this runs on both gamepad events.
    showTouchPad = touchPadWanted(applied.padCount);
  }

  /** Finds the ROM locally, then asks the player. There is no host to ask. */
  async function obtainRom(): Promise<Uint8Array> {
    if (!gameCrc32) {
      throw new Error('This room predates local ROMs; re-add the game to your library.');
    }

    const found = await resolveQuietly(gameCrc32);
    if (found) {
      logger.info(`Loaded the ROM from this machine (${found.byteLength} bytes)`, {
        crc32: gameCrc32
      });
      return found;
    }

    logger.info('No local copy found; asking the player', { crc32: gameCrc32 });
    statusText = 'Waiting for you to locate the ROM…';
    return new Promise<Uint8Array>((resolve) => {
      romPrompt = (bytes) => {
        romPrompt = null;
        statusText = 'Loading the ROM…';
        remember(bytes);
        resolve(bytes);
      };
    });
  }

  /**
   * Loads the battery save before the first frame runs.
   *
   * This is the in-game save - what the player writes from the cartridge's own
   * menu - so it is part of the emulated machine and has to be in place before
   * emulation starts.
   *
   * Invariant `sramLoaded` depends on: it means the server's copy was read
   * and applied - or, for a new game, that the server confirmed there was
   * none to apply. Every path that sets it true must be a path where that is
   * actually true; a caught decode error and an unanswered request are both
   * "did not read" and must leave it false. `persistSram()` trusts this flag
   * completely to decide whether writing back is safe, so setting it on a
   * failure path is a silent, permanent way to overwrite a real save with a
   * blank one - it has happened twice already.
   */
  function loadSram(): Promise<void> {
    return new Promise((resolve) => {
      const sock = $socket;
      if (!sock || !core) {
        // Neither piece exists to read from or into, so this is exactly as
        // much a "did not read" as a server timeout - the player deserves the
        // same warning, not silence.
        sramNotice = SRAM_UNAVAILABLE_NOTICE;
        return resolve();
      }

      const done = (data: { sramData: string | null }) => {
        sock.off('game:sramLoaded', done);
        clearTimeout(timeoutHandle);
        try {
          if (data.sramData) {
            const bytes = decodeSram(data.sramData);
            core!.loadSram(bytes);
            logger.info('Battery save restored', { bytes: bytes.length });
            sramLoaded = true;
          } else {
            // The server has nothing for us - a new game - which is still a
            // successful read: a first save still has to be able to persist.
            sramLoaded = true;
          }
        } catch (err) {
          // A payload we could not decode is a read that did not succeed.
          // sramLoaded stays false, so persistSram() will not overwrite
          // whatever real save the server holds with the blank SRAM the ROM
          // just started with.
          logger.error('Could not restore the battery save', err);
          sramNotice = SRAM_DECODE_ERROR_NOTICE;
        }
        resolve();
      };

      sock.on('game:sramLoaded', done);
      sock.emit('game:loadSram', { roomId });
      // Never block the boot on a server that does not answer. Deliberately
      // does not set sramLoaded: if we could not read, we must not write, for
      // the rest of the session - and the player is told why. Cleared inside
      // done() when the handler wins the race, so this does not fire late
      // and touch a possibly-destroyed component.
      const timeoutHandle = setTimeout(() => {
        sock.off('game:sramLoaded', done);
        if (!sramLoaded) {
          sramNotice = SRAM_UNAVAILABLE_NOTICE;
        }
        resolve();
      }, 5000);
    });
  }

  /**
   * Applies a state loaded from the pause menu's Load Game screen.
   *
   * LockstepRoom's equivalent (onSaveLoaded) adopts the state and reseeds the
   * session, because there a guest also has to be resynchronised onto it.
   * Solo has no one to synchronise: applying the bytes directly to the core
   * is the whole job, per the spec ("il n'y a ici personne à synchroniser").
   */
  function onGameLoaded(payload: { saveData?: string; name?: string }): void {
    if (!core || !payload?.saveData) return;
    try {
      const bytes = fromBase64(payload.saveData);
      core.loadState(bytes);
      // Otherwise audio buffered before the jump plays over the restored
      // state.
      audio?.flush();
      logger.info('Loaded save', { name: payload.name });
    } catch (err) {
      logger.error('Could not decode the save', err);
    }
  }

  /**
   * A power cycle: the CPU restarts, the cartridge keeps its battery.
   *
   * `core.reset()` leaves SRAM alone, which is what a real console does and
   * why this deliberately does not call `persistSram()` or clear anything -
   * the player's in-game save file survives a restart, exactly as it should.
   *
   * The flush is for the same reason as in `onGameLoaded`: audio queued for
   * the frames that are about to stop existing would otherwise play over the
   * title screen.
   */
  function resetGame(): void {
    if (!core) return;
    core.reset();
    audio?.flush();
    logger.info('Restarted the machine');
  }

  /**
   * A rebind: applied here, and reported upward.
   *
   * Assigning locally is what makes the new bindings live on this machine at
   * once, without waiting for a round trip. The dispatch is the other half,
   * and it was missing: this component had no dispatcher at all, so the page's
   * `on:controlsSaved` was a listener nothing ever fired. Its `userControls`
   * therefore stayed at whatever it held on arrival, and since that value is
   * pushed back down as the `controls` prop, anything that re-evaluated it
   * handed this component its own pre-rebind config again. The same shape as
   * LockstepRoom's `handleControlsSaved`, for the same reason.
   */
  function handleControlsSaved(event: CustomEvent<{ config: ControlsConfig }>): void {
    controls = event.detail.config;
    dispatch('controlsSaved', event.detail);
  }

  function persistSram(): void {
    if (!sramLoaded) return;
    if (!core || !$socket) return;
    const sramData = encodeSram(core);
    if (!sramData) return;
    $socket.emit('game:saveSram', { roomId, sramData });
  }

  async function boot() {
    try {
      setLogLabels({ roomId, player: 'solo' });

      surface = createRendererSurface({
        canvas2d,
        canvasGl,
        getCore: () => core,
        logger,
        onChange: onSurfaceChange
      });

      statusText = 'Loading emulator core…';
      core = await loadCore();
      if (destroyed) {
        teardown();
        return;
      }

      statusText = 'Locating the ROM…';
      loadedRom = await obtainRom();
      if (destroyed) {
        teardown();
        return;
      }
      core.loadRom(normaliseRom(loadedRom));

      await loadSram();
      if (destroyed) {
        teardown();
        return;
      }

      const storedShader = readShaderPreference(localStorage);
      if (storedShader) {
        display = { ...display, shader: storedShader };
      }

      renderer = new CanvasRenderer(canvas2d);
      renderer.draw(core);

      audio = new AudioSink();
      await audio.start(Math.round(core.sampleRate));
      if (destroyed) {
        teardown();
        return;
      }
      // Ask, do not assume: a room is reached by clicking, so the context
      // is usually already running and no gesture is needed.
      needsAudioGesture = audio.needsGesture;

      assignments = loadAssignments(localStorage);
      const pads = connectedPads();
      const sources = resolveSources(assignments, pads);
      showTouchPad = touchPadWanted(pads.length);

      collector1 = new InputCollector(controls.p1, sources.p1);
      collector1.attach();
      // Player 1 only: the touch pad is this machine's own screen, and a phone
      // is held by one player.
      collector1.setTouchPad(touchPad);
      // Created even when P2 is silent: its sources are then empty, it reads
      // 0, and assigning it mid-session then only has to push new sources
      // rather than construct anything.
      collector2 = new InputCollector(controls.p2, sources.p2);
      collector2.attach();

      window.addEventListener('gamepadconnected', applySources);
      window.addEventListener('gamepaddisconnected', applySources);

      session = new SoloSession({
        core,
        readLocalInput: () => ({
          pad1: collector1!.read(),
          pad2: allowLocalPlayer2 && isPlayerActive(assignments.p2) ? collector2!.read() : 0
        }),
        onFrame: () => {
          renderer!.draw(core!);
          audio!.push(core!.audio());
        }
      });

      governor = new FrameGovernor(session, {
        fps: core.fps || 60.0988,
        onSlice: () => checkRendererHealth(),
        // Solo has no peer to freeze by pausing: let a hidden tab actually
        // stop instead of burning a CPU core in the background, the way the
        // rAF-only path this replaced always did.
        keepRunningWhenHidden: false
      });
      governor.start();
      sramTimer = setInterval(persistSram, 30000);
      $socket?.on('game:loaded', onGameLoaded);

      phase = 'playing';
      statusText = '';

      // After the listener is registered and the session is running, which is
      // the only order that works: the reply carries the savestate and there
      // would be nothing to apply it to a moment earlier.
      if (resumeSaveId) {
        $socket?.emit('game:load', { roomId, saveId: resumeSaveId });
        resumeSaveId = null; // Once. A reconnect must not rewind the game.
      }

      // After the session is running, so a slow CDN cannot delay the picture.
      if (display.shader) void applyShader(display.shader);
    } catch (err) {
      logger.error('Solo boot failed', err);
      errorText = err instanceof Error ? err.message : String(err);
      phase = 'error';
      teardown();
    }
  }

  async function startAudio() {
    try {
      await audio?.resume();
    } catch (err) {
      logger.error('Could not start audio', err);
    }
    // Re-read rather than clear: if resume failed the button has to stay, or
    // the player is left with silence and nothing to click.
    needsAudioGesture = audio?.needsGesture ?? false;
  }

  /**
   * Opens the pause menu and actually pauses.
   *
   * LockstepRoom cannot stop its governor here: stopping it would stop
   * sending pads, and the peer would freeze too. Solo has no peer, so it is
   * free to do the better thing a pause menu implies - the game really stops,
   * not just the keyboard.
   */
  function openPauseMenu(restoreFullscreen = false): void {
    if (showPauseMenu) return;
    pauseRestoresFullscreen = restoreFullscreen;
    showPauseMenu = true;
    // Solo can really pause: there is no peer to freeze by stopping the
    // clock. LockstepRoom only detaches input because stopping its governor
    // would stall the other player.
    governor?.stop();
    collector1?.detach();
    collector2?.detach();
    // Matches P2PRoom's auto-save on pause: a player who opens the menu is
    // often about to save or leave, and membership is still live here.
    persistSram();
  }

  function closePauseMenu(): void {
    showPauseMenu = false;
    // ControlsSettings writes a device assignment straight to storage
    // without dispatching anything - assignments do not wait for Save - so
    // this is the one place a device reassigned while paused reaches the
    // running collectors. setSources() already clears held keys when the
    // keyboard is taken from a player, so a direction held at the moment the
    // keyboard is disabled cannot jam.
    applySources();
    // Input first: the first frame after resuming reads a live pad, not a
    // stale zero left over from before the clock restarts.
    collector1?.attach();
    collector2?.attach();
    governor?.start();
    // PauseMenu's own restoreFullscreen prop would fullscreen
    // document.documentElement, not this component's own container - the
    // same reason LockstepRoom restores fullscreen itself rather than
    // handing the prop to PauseMenu.
    if (pauseRestoresFullscreen && !document.fullscreenElement) {
      container?.requestFullscreen().catch((err) => logger.error('Could not restore fullscreen', err));
    }
    pauseRestoresFullscreen = false;
  }

  /**
   * Fast-forward. Solo owns the clock outright, so nothing else has to agree
   * to it - unlike lockstep, where FrameGovernor.setTurbo exists but nothing
   * calls it, because turbo only makes sense when every peer runs it
   * together. The path this replaced bound the same key to the same thing.
   */
  /**
   * Fast-forward, with the sound muted while it lasts.
   *
   * The sink plays at real time and turbo produces up to four times as many
   * samples, so feeding it during turbo grows a queue that never drains: the
   * worklet's one-second cap starts dropping the oldest chunks, which is
   * audible as clicks, and whatever survives arrives late for as long as
   * turbo ran. Muting removes the cause rather than the symptom - and
   * `setMuted(true)` already flushes what is queued, so switching back is
   * immediate instead of playing seconds of stale audio.
   *
   * This is what emulators do on fast-forward. Sped-up sound is not worth
   * hearing anyway.
   */
  function toggleTurbo(): void {
    turbo = !turbo;
  }

  /**
   * The union, applied wherever it lands.
   *
   * Reactive rather than pushed from each handler, because there are two ways
   * in - a menu entry that latches and a pad button that is held - and the
   * governor must never be told one of them in isolation. Releasing the button
   * therefore does not cancel a fast-forward the menu had switched on, which
   * is the whole reason this is a union and not a single flag.
   *
   * It also re-runs when `governor` and `audio` are assigned during boot, which
   * is how a state set before they existed reaches them.
   */
  $: {
    const fast = turbo || turboHeld;
    governor?.setTurbo(fast);
    audio?.setMuted(fast);
  }

  /*
   * A button that is gone cannot be released.
   *
   * The touch pad is unmounted whenever the pause menu opens, and unmounting
   * fires no `pointerup` - so a thumb still on fast-forward when the menu came
   * up would leave the game running at four times speed with nothing holding
   * it and nothing to let go of. The component says so on its way out too;
   * this is the half that cannot be missed, because it is derived from whether
   * the pad is on screen at all rather than from an event.
   */
  $: if (!showTouchPad || showPauseMenu) turboHeld = false;

  function onKeyDown(event: KeyboardEvent): void {
    if (event.altKey && event.key === 'Enter') {
      event.preventDefault();
      void toggleFullscreen();
      return;
    }
    if (event.key === 'Tab') {
      // Tab moves focus otherwise.
      event.preventDefault();
      toggleTurbo();
      return;
    }
    /*
     * F2 and F4, unless the player bound them to their pad.
     *
     * `event.code`, not `event.key`: the controls screen records codes, so
     * comparing anything else would let a bound key slip through the check.
     * Skipped while the pause menu is open - the menus have their own buttons
     * for this, and a shortcut firing behind an open dialog is a surprise.
     */
    if (!showPauseMenu && (event.code === QUICK_SAVE_KEY || event.code === QUICK_LOAD_KEY)) {
      if (padUsesKey(controls.p1.keys, event.code) || padUsesKey(controls.p2.keys, event.code)) return;
      event.preventDefault();
      const ctx = { socket: $socket, roomId, gameId, locale: $language };
      if (event.code === QUICK_SAVE_KEY) void quickSave({ ...ctx, emulator: saveAdapter });
      else void quickLoad(ctx);
      return;
    }

    if (event.key !== 'Escape' || showPauseMenu) return;
    event.preventDefault();
    openPauseMenu(!!document.fullscreenElement);
  }

  /** Leaving the room: told to the server the same way LockstepRoom does it. */
  function quitToLobby(): void {
    // First, and this is not decoration. The server gates `game:saveSram` on
    // room membership, and quitting a room of one gives that membership up:
    // the page's `leaveGame` emits `room:leave` before it navigates. Anything
    // written after that is refused, teardown's own attempt included. Saving
    // here, while the seat is still ours, is what actually reaches the server.
    //
    // (It used to be the page's `onDestroy` that emitted `room:leave`, which is
    // what the comment here described until dbed6c9 took it out. The ordering
    // conclusion survived the mechanism that produced it.)
    persistSram();
    // Reset first, not read back from document.fullscreenElement inside
    // closePauseMenu() after exitFullscreen() - that promise resolves
    // asynchronously, so relying on its timing would be fragile.
    pauseRestoresFullscreen = false;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    closePauseMenu();
    $socket?.emit('room:release-game', { roomId });
    // Said upwards rather than waited for. `room:release-game` is how the
    // server and any partner hear about this, but the room page leaves on its
    // own: a room-scoped event naming a room the server no longer has is
    // dropped in silence, and then a quit that waited for `game:stopped`
    // would never come back at all. See the page's own `leaveGame`.
    dispatch('quit');
  }

  function teardown() {
    destroyed = true;
    if (sramTimer) clearInterval(sramTimer);
    sramTimer = null;
    // Best-effort, and refused on the one path that matters: quitting a room
    // of one has already emitted `room:leave` by now, so the server no longer
    // counts us as a member. The saves that carry are the ones in
    // quitToLobby() and openPauseMenu(), which run while the seat is live.
    // This one covers leaving by any other route - closing the tab, navigating
    // away - where membership is untouched and it lands.
    persistSram();
    $socket?.off('game:loaded', onGameLoaded);
    window.removeEventListener('gamepadconnected', applySources);
    window.removeEventListener('gamepaddisconnected', applySources);
    governor?.stop();
    governor = null;
    session = null;
    collector1?.detach();
    collector1 = null;
    collector2?.detach();
    collector2 = null;
    void audio?.stop();
    audio = null;
    surface?.dispose();
    surface = null;
    renderer = null;
    core?.dispose();
    core = null;
    fullscreen.detach();
    window.removeEventListener('keydown', onKeyDown);
  }

  onMount(() => {
    fullscreen.attach();
    window.addEventListener('keydown', onKeyDown);
    void boot();
  });

  onDestroy(() => {
    teardown();
  });
</script>

<div class="solo" class:paused={showPauseMenu} class:touch={showTouchPad} bind:this={container}>
  <!--
    Double-click toggles fullscreen, the way a video player does. It is not a
    menu entry because Escape has to reach the menu, and the browser keeps
    Escape for leaving fullscreen - so a menu you open with Escape is the one
    place fullscreen must not be toggled from. Alt+Enter still works.
  -->
  <div
    class="screen"
    on:dblclick={toggleFullscreen}
    role="presentation"
    use:fitToBox={displayRatio}
  >
    <canvas bind:this={canvas2d} class:inactive={usingGl} width="256" height="224"></canvas>
    <canvas bind:this={canvasGl} class:inactive={!usingGl} width="256" height="224"></canvas>

    {#if shaderNotice || sramNotice}
      <!-- A column, not two independently-positioned notices: both used to
           sit at bottom: 0 and render on top of each other when both fired
           at once. -->
      <div class="notices">
        {#if shaderNotice}
          <p class="notice">{shaderNotice}</p>
        {/if}
        {#if sramNotice}
          <p class="notice">{sramNotice}</p>
        {/if}
      </div>
    {/if}

    {#if phase !== 'playing'}
      <div class="overlay">
        {#if phase === 'error'}
          <p class="error">{errorText}</p>
          <button class="action" on:click={() => goto('/')}>Back to the lobby</button>
        {:else}
          <p>{statusText}</p>
        {/if}
      </div>
    {/if}

    {#if needsAudioGesture}
      <button class="audio-gesture" on:click={startAudio}>Click for sound</button>
    {/if}
  </div>

  <!--
    Only the menu button remains on screen. Everything else moved into the
    pause menu, which is where settings nobody changes mid-game belong - and
    where they inherit its keyboard and gamepad navigation. This button stays
    because it is the only way to reach the menu without a keyboard.
  -->
  <div class="toolbar">
    <button class="action" on:click={() => openPauseMenu(isFullscreen)}>☰ Menu (Esc)</button>
  </div>
  <!-- Not while the menu is up: a lockstep session keeps running behind it,
       so a thumb still resting on the pad would go on playing under a menu
       the player thinks has stopped the game. Unmounting releases what was
       held. -->
  {#if showTouchPad && !showPauseMenu}
    <!--
      Below the picture in landscape, floating over the black in portrait -
      which is what the media query at the bottom of this file decides. The
      component knows neither: it fills the box it is given.
    -->
    <div class="touch-zone">
      <TouchControls pad={touchPad} canTurbo={true} on:turbo={(e) => (turboHeld = e.detail)} />
    </div>
  {/if}

  {#if romPrompt}
    <LocateRom checksum={gameCrc32 ?? ''} title={gameTitle} on:found={(e) => romPrompt?.(e.detail)} />
  {/if}

  {#if showPauseMenu}
    <PauseMenu
      {roomId}
      {gameId}
      keyConfig={controls.p1.keys}
      {controls}
      localPlayer2Playable={allowLocalPlayer2}
      {display}
      {turbo}
      canReset={true}
      emulator={saveAdapter}
      on:resume={closePauseMenu}
      on:quit={quitToLobby}
      on:reset={resetGame}
      on:display={(e) => void onDisplayChange(e.detail)}
      on:turbo={toggleTurbo}
      on:controlsSaved={handleControlsSaved}
    />
  {/if}
</div>

<style>
  .solo {
    display: flex;
    flex-direction: column;
    /* What the touch pad is positioned against in portrait. */
    position: relative;
    align-items: center;
    gap: 0.75rem;
    /* The page centres its children, so claim the full height rather than
       settling for the content's. */
    align-self: stretch;
    height: 100%;
    min-height: 0;
    /* Without this the width comes up from the content, which means from the
       canvas's buffer - so a 6x shader resized the whole layout, 'Fit' and
       'Stretch' looked identical because the box already matched the picture's
       ratio, and 'Sharp' had nothing to smooth because nothing was upscaled. */
    width: 100%;
  }

  .touch-zone {
    /* Landscape: the controller takes the bottom of the window and the picture
       keeps the rest. Nothing else has to change - .screen is flex: 1 and
       fitToBox re-measures it, so the canvas reshapes itself. */
    width: 100%;
    height: clamp(8rem, 40vh, 15rem);
    flex: none;
  }

  /*
   * A phone on its side: the picture takes the whole height and the controls
   * move into the black beside it.
   *
   * The 8:7 picture cannot use that width - on a 844x390 screen it leaves
   * about 200px of black on each side - so a band below was paying for the
   * controls twice. Measured on that screen: the picture goes from 203x178 to
   * 395x346. The aspect-ratio condition is what keeps a 4:3 tablet out of
   * this: below 16/9 a full-height picture leaves too little black to hold a
   * stick, and the band below is right. TouchControls rearranges itself under
   * the same query.
   */
  @media (orientation: landscape) and (min-aspect-ratio: 16 / 9) {
    .solo.touch .touch-zone {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: min(74vh, 17rem);
      pointer-events: none;
    }
  }

  @media (orientation: portrait) {
    .touch-zone {
      /* Upright there is no height to give away: a 4:3 picture across a phone
         already leaves little, and a second band would make the game
         postage-stamp sized. So the pad floats over the black instead, dimmed
         until a thumb lands on it. */
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: min(40vh, 20rem);
      opacity: 0.75;
    }

    /* The menu button would sit under the floating pad, and it is the only way
       into the menu without a keyboard - so on a phone it moves to the top. */
    .solo.touch .toolbar {
      order: -1;
    }

    /* And the picture goes up, out of the pad's way, rather than staying
       centred in a box the pad now covers the bottom of. */
    .solo.touch .screen {
      align-items: flex-start;
    }
  }

  .screen {
    position: relative;
    /* Take whatever the toolbar leaves, in both directions. No max-width and
       no fixed ratio: the ratio belongs to the picture inside, not to the box,
       which is what lets 1:1 and 4:3 be a real choice. */
    flex: 1;
    min-height: 0;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
    overflow: hidden;
  }

  canvas {
    /* Sized by the fitToBox action on .screen; the fallback covers the frames
       before the first measurement. */
    width: var(--fit-width, 100%);
    height: var(--fit-height, 100%);
    /* The box already carries the intended ratio, so there is nothing to
       letterbox inside it. */
    object-fit: fill;
    image-rendering: pixelated;
    display: block;
  }

  canvas.inactive {
    display: none;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
  }

  .error {
    color: #f87171;
    max-width: 32rem;
    text-align: center;
  }

  .notices {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
  }

  .notice {
    margin: 0;
    padding: 0.35rem 0.6rem;
    background: rgba(0, 0, 0, 0.6);
    color: #e0b040;
    font-size: 0.8rem;
    text-align: center;
  }

  .audio-gesture {
    position: absolute;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.5rem 1rem;
    border-radius: 6px;
    border: none;
    background: #667eea;
    color: #fff;
    cursor: pointer;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .action {
    background: #333;
    border: 2px solid transparent;
    color: #fff;
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
  }

  .action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .solo:fullscreen {
    position: relative;
    width: 100%;
    height: 100%;
    justify-content: center;
    gap: 0;
    background: #000;
    /* The layout hides the cursor on every fullscreen element, which is right
       while playing and wrong with the pause panel open: a panel you cannot
       see the pointer over is a panel you cannot click. */
    cursor: default;
  }

  .solo:fullscreen .screen {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  .solo:fullscreen .toolbar {
    position: absolute;
    bottom: 0.5rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2;
  }
  /*
   * The pause panel is fixed to the left edge, so it pushes nothing by itself.
   * Reserving its width here is what makes the game shrink rather than be
   * covered - and .screen's ResizeObserver re-fits the picture as the padding
   * animates, which keeps it crisp instead of scaled.
   */
  .solo {
    --pause-panel-width: 20rem;
    transition: padding-left 220ms cubic-bezier(0.33, 1, 0.68, 1);
  }

  .solo.paused {
    padding-left: var(--pause-panel-width);
  }

  /* Narrow: the panel covers instead, so there is nothing to reserve. */
  @media (max-width: 700px) {
    .solo.paused {
      padding-left: 0;
    }
  }
</style>
