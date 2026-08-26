<script lang="ts">
  /**
   * ZSNES-style lockstep netplay room.
   *
   * An alternative to the existing dual and streaming modes. Both players run
   * a deterministic snes9x build, pads are exchanged with a fixed input delay
   * through the server relay, and no frame runs until every player's pad for
   * it has arrived. There is no rollback and no prediction: when the network
   * hiccups the picture freezes, and when it recovers play resumes exactly
   * where both machines left off.
   *
   * See frontend/src/lib/znet/session.ts for the protocol.
   */
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { goto } from '$app/navigation';
  import { socket } from '$lib/api/socket';
  import type { KeyConfig } from '$lib/types';
  import type { ControlsConfig } from '$lib/controls/binding';
  import { createLogger } from '$lib/utils/logger';
  import { fromBase64 } from '$lib/saves/base64';
  import { setLogLabels } from '$lib/utils/log-shipper';
  import { encodeSram, decodeSram } from '$lib/rooms/sram';
  import { applyInputSources } from '$lib/rooms/input-sources';
  import PauseMenu from './PauseMenu.svelte';
  import { language, type Language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { QUICK_SAVE_KEY, QUICK_LOAD_KEY, padUsesKey } from '$lib/saves/quick';
  import { quickSave, quickLoad } from '$lib/saves/quick-actions';
  import LocateRom from './LocateRom.svelte';
  import TouchControls from './TouchControls.svelte';
  import { TouchPad, touchPadWanted } from '$lib/controls/touch';
  import { remember, resolveQuietly } from '$lib/roms/provider';
  import { receiveRom, sendRom } from '$lib/roms/transfer';
  import { readShaderPreference, writeShaderPreference } from '$lib/stores/shader-preference';
  import { DEFAULT_DISPLAY, type DisplayOptions, type Renderer } from '$lib/znet';
  import {
    AudioSink,
    CanvasRenderer,
    WebglRenderer,
    loadShaderPreset,
    FrameGovernor,
    InputCollector,
    NetplaySession,
    PsnesCore,
    SocketTransport,
    LagTransport,
    parseLag,
    loadCore,
    normaliseRom,
    romCrc32,
    aspectRatioOf,
    fitToBox,
    loadAssignments,
    saveAssignments,
    resolveSources,
    connectedPads,
    type Assignments,
    type SessionEvent,
    type SessionStats,
    type Transport
  } from '$lib/znet';
  import {
    LOW_DELAY_FRAMES,
    readLatencyPreference,
    writeLatencyPreference
  } from '$lib/stores/latency-preference';
  import type { LatencyMode } from '$lib/types';

  const logger = createLogger('LockstepRoom');

  export let roomId: string;
  export let gameId: string;
  /** The CRC32 of the room's ROM: how each player finds their own copy. */
  export let gameCrc32: string | undefined = undefined;
  export let gameTitle = '';
  export let isHost: boolean;
  /** The room's latency trade-off, decided by its creator and broadcast to all. */
  export let latencyMode: LatencyMode = 'auto';
  /** Whether this player is the creator, and so may change it. */
  export let canSetLatency = false;
  export let keyConfig: KeyConfig;
  /**
   * The two-player config, relayed to `PauseMenu`'s controls sub-menu.
   *
   * Distinct from `keyConfig`: lockstep only ever plays P1 locally, but the
   * panel edits both players and must not be handed just the half in play.
   */
  export let controls: ControlsConfig;
  /**
   * A save to open on, when the library sent us here to resume one.
   *
   * Asked for once the session reports itself running, through the same
   * `game:load` the pause menu uses: the host reseeds the session from the
   * state and the guest is handed the machine, which is already the safe path
   * for loading a save mid-match. Nothing new touches the sync.
   */
  export let resumeSaveId: string | null = null;
  /** Frames of input delay. 0 asks for a value derived from the measured RTT. */
  export let inputDelay = 0;

  /**
   * One canvas per context type.
   *
   * A canvas that has produced a webgl2 context can never produce a 2d one, so
   * switching renderers means switching elements. Both are declared in the
   * markup and one is hidden, which keeps Svelte the owner of both - replacing
   * a bound element at runtime would leave Svelte holding a detached node.
   */
  let canvas2d: HTMLCanvasElement;
  let canvasGl: HTMLCanvasElement;
  let usingGl = false;
  /** The element that goes fullscreen; holds the picture and every overlay. */
  let stage: HTMLDivElement;
  let phase: 'loading' | 'waiting' | 'playing' | 'error' = 'loading';
  let statusText = 'Loading core…';
  let errorText = '';
  /**
   * Set once the component is gone, so a suspended boot() cannot build on a
   * corpse.
   *
   * boot() awaits the core, the ROM, the audio device, the battery save and
   * the relay - five points where the room can be destroyed underneath it.
   * Svelte then runs teardown() from onDestroy, and only afterwards does the
   * suspended boot() resume and build a fresh AudioSink, InputCollector and
   * FrameGovernor that nothing will ever stop, because the one teardown()
   * already happened. Cleanup running zero times rather than once.
   */
  let destroyed = false;
  let needsAudioGesture = false;
  /** Set while the boot is parked waiting for the player to point at a file. */
  let romPrompt: ((bytes: Uint8Array) => void) | null = null;
  /** Chunks sent or received, for a transfer the player can watch. */
  let romTransfer: { direction: 'in' | 'out'; done: number; total: number } | null = null;
  let showStats = false;

  /** Kept so a guest arriving later can be served without touching the disk. */
  let loadedRom: Uint8Array | null = null;

  let core: PsnesCore | null = null;
  let session: NetplaySession | null = null;
  let governor: FrameGovernor | null = null;
  let transport: Transport | null = null;
  let collector: InputCollector | null = null;
  /**
   * The on-screen controller, for a machine with no keys.
   *
   * Its mask joins the session through the same collector a keyboard does, so
   * the pads that travel to the other peer are indistinguishable from a
   * keyboard player's - lockstep needs no notion of a phone.
   */
  const touchPad = new TouchPad();
  let showTouchPad = false;
  let renderer: Renderer | null = null;
  let audio: AudioSink | null = null;

  /**
   * Which gamepad drives P1 here, read from the same store the controls
   * panel writes to - this is the only local player lockstep has.
   */
  let assignments: Assignments = loadAssignments(localStorage);

  let stats: SessionStats | null = null;
  /**
   * Whether to *show* that we are waiting, which is not the same as waiting.
   *
   * Brief stalls are normal on a lockstep link and do not affect play; a badge
   * that flashes on each one reads as a fault and trains the eye to ignore it.
   * It appears only once a stall has lasted long enough to be felt, and clears
   * the instant play resumes. The telemetry is untouched - every stall is
   * counted and logged the moment it happens.
   */
  const STALL_VISIBLE_AFTER_MS = 600;
  let stalling = false;
  let stallVisible = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let lastResyncAt = 0;

  /**
   * A link that has gone quiet but is expected back.
   *
   * Kept separate from `phase` on purpose: `phase = 'error'` is terminal and
   * swaps in the error screen, whereas this must be able to clear itself. The
   * canvas keeps showing its last frame underneath.
   */
  let linkLost = false;

  let showPauseMenu = false;
  let display: DisplayOptions = { ...DEFAULT_DISPLAY };
  /** Set when a shader was asked for and could not be delivered. Plain English, like the rest of this component. */
  let shaderNotice: string | null = null;
  /** Guards against overlapping swaps when the player clicks the button quickly. */
  let shaderSwapToken = 0;

  /**
   * Fullscreen, which is local and cosmetic like the display options: it
   * changes how the picture is shown and never what the core computes, so the
   * two players can be in different states without any risk to the lockstep.
   */
  let isFullscreen = false;
  /**
   * Distinguishes a fullscreen change we asked for from one Escape forced on
   * us. The browser exits fullscreen on Escape and swallows the keydown, so
   * without this flag there is no way to tell "the player wanted out" from
   * "the player asked for the menu" - and the menu would never open.
   */
  let deliberateFullscreenChange = false;
  /** Set when the menu was opened from fullscreen, so resuming can go back. */
  let wasFullscreen = false;

  /**
   * The toolbar is an overlay in fullscreen: shown on pointer activity, hidden
   * again once the player settles down, so it does not sit over the picture
   * for a whole session. Hovering it holds it open (CSS), which is why the
   * timer can be this short.
   */
  const CHROME_IDLE_MS = 2500;
  let chromeVisible = true;
  let chromeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether the pointer or the focus is on the toolbar itself.
   *
   * A pointer resting on a button sends no further mousemove, so the countdown
   * would hide the very control the player is reaching for - and a hidden
   * toolbar takes `pointer-events: none`, so CSS `:hover` cannot rescue it.
   * The hold has to be tracked here, where it can stop the timer.
   */
  let chromeHeld = false;


  /** Drops back to the 2D renderer on its own canvas. Always succeeds. */
  function useCanvasRenderer(): void {
    renderer?.dispose();
    usingGl = false;
    // The button reads display.shader, so leaving it set would keep
    // advertising a shader that is not running. The stored preference is
    // deliberately left alone: it is the player's choice, and it should be
    // retried on the next load rather than silently forgotten.
    display = { ...display, shader: '' };
    renderer = new CanvasRenderer(canvas2d);
    renderer.setOptions(display);
    if (core) renderer.draw(core);
  }

  /**
   * Switches the renderer to run `shaderId`, or keeps 2D and says why.
   *
   * Every failure lands in the same place: a working 2D renderer plus a
   * notice. The player is never left looking at a black canvas wondering
   * whether the game crashed - which is exactly what xbrz-freescale used to do
   * before it was removed from the shader list.
   */
  async function applyShader(shaderId: string): Promise<void> {
    const token = ++shaderSwapToken;
    shaderNotice = null;

    if (!shaderId) {
      useCanvasRenderer();
      return;
    }

    const loaded = await loadShaderPreset(shaderId);
    // The player may have picked something else while this was fetching.
    if (token !== shaderSwapToken) return;

    if (!loaded.ok) {
      logger.warn('shader unavailable', { shaderId, reason: loaded.reason });
      shaderNotice = 'That shader could not be loaded; showing raw pixels.';
      useCanvasRenderer();
      return;
    }

    // If WebglRenderer.create fails below, useCanvasRenderer() disposes this
    // same (already-disposed) renderer again. That is safe: dispose() on both
    // renderer types guards every deletion and nulls what it deletes, so
    // nothing gets double-freed.
    renderer?.dispose();

    const webgl = WebglRenderer.create(canvasGl, loaded.preset);
    if (!webgl) {
      logger.warn('webgl2 unavailable or the shader would not compile', { shaderId });
      shaderNotice = 'Shaders need WebGL2, which this browser did not provide.';
      useCanvasRenderer();
      return;
    }

    usingGl = true;
    renderer = webgl;
    renderer.setOptions(display);
    if (core) renderer.draw(core);
  }

  /**
   * Takes a display change from the pause menu.
   *
   * A shader change needs a whole new renderer, because the renderer is built
   * from a compiled preset and never re-reads the field. Assigning `display`
   * alone would move the menu's label and leave the picture untouched.
   */
  async function onDisplayChange(next: DisplayOptions): Promise<void> {
    const shaderChanged = next.shader !== display.shader;
    display = next;
    if (!shaderChanged) return;

    writeShaderPreference(localStorage, next.shader);
    await applyShader(next.shader);
  }

  /**
   * Falls back to 2D if the GL context died mid-game.
   *
   * Polled from the governor's existing slice callback rather than from an
   * event handler here: the renderer is the only thing that knows, and giving
   * it a way to call back into the room is exactly the coupling this design
   * refuses. One boolean read per slice, and no new timer.
   */
  function checkRendererHealth(): void {
    if (renderer instanceof WebglRenderer && renderer.unusable) {
      // Reason-agnostic on purpose: `unusable` covers both a lost browser
      // context and allocate() giving up (e.g. a shader's render target
      // too large for the driver), and the player does not need to know
      // which - both end the same way, a working 2D picture.
      logger.warn('webgl renderer unusable, falling back to 2D');
      shaderNotice = 'Hardware shaders stopped working; showing raw pixels.';
      useCanvasRenderer();
    }
  }

  /**
   * What the save menu needs from an emulator: a state it can store, and the
   * canvas it can photograph for the thumbnail.
   *
   * Saving reads the machine without touching it, so it needs no coordination
   * with the other player - unlike loading, which goes through the session so
   * both peers land on the same machine.
   */
  $: activeCanvas = usingGl ? canvasGl : canvas2d;
  $: displayRatio = aspectRatioOf(display.aspect);

  $: saveAdapter = core
    ? { saveState: async () => core!.saveState(), getCanvas: () => activeCanvas }
    : null;

  $: if (renderer && display) renderer.setOptions(display);

  /** Periodic health line; see startDiagnostics. */
  let diagnosticsTimer: ReturnType<typeof setInterval> | null = null;
  let sramTimer: ReturnType<typeof setInterval> | null = null;
  let lastFramesRun = 0;

  // `controls.p1.pad`, not the standard mapping: a player who rebound their
  // controller must be honoured here too. Only P1 plays locally in lockstep -
  // port 2 belongs to the remote peer - so P1's is the whole of it.
  $: if (collector && keyConfig) collector.setControls({ keys: keyConfig, pad: controls.p1.pad });

  onMount(() => {
    // Registered before the core starts loading, not after. Both machines boot
    // at once and the guest asks for the ROM straight away; a listener attached
    // at the end of boot would miss the first requests.
    if (isHost) $socket?.on('rom:request', onRomRequested);
    $socket?.on('znet:error', onRelayError);
    $socket?.on('player:left', onPlayerLeft);

    void boot();
    window.addEventListener('keydown', onGlobalKey);
    // On the window rather than on the stage: in fullscreen the stage is the
    // whole screen, so any pointer activity at all is the player asking for
    // the toolbar. pointerdown covers touch, which sends no mousemove.
    window.addEventListener('mousemove', onPointerActivity);
    window.addEventListener('pointerdown', onPointerActivity);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      window.removeEventListener('keydown', onGlobalKey);
      window.removeEventListener('mousemove', onPointerActivity);
      window.removeEventListener('pointerdown', onPointerActivity);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  });

  function onGlobalKey(event: KeyboardEvent) {
    if (event.altKey && event.key === 'Enter') {
      event.preventDefault();
      void toggleFullscreen();
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
      if (padUsesKey(keyConfig, event.code)) return;
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

  const dispatch = createEventDispatcher();

  function openPauseMenu(restoreFullscreen = false) {
    if (showPauseMenu) return;
    wasFullscreen = restoreFullscreen;
    showPauseMenu = true;
    // Release every held key: the menu swallows keyups, and in lockstep a
    // stuck direction is sent to the other player too.
    collector?.detach();
  }

  /**
   * Re-reads the assignment and re-pushes P1's sources into the collector.
   *
   * The three ways the answer can change while a match runs, and all three
   * come through here: a pad plugged in or unplugged (the two window
   * listeners), and a device reassigned in the controls panel, which writes
   * straight to storage without dispatching anything - assignments do not
   * wait for Save - so closing the pause menu is where it lands.
   * `setSources()` already clears held keys when the keyboard is taken away,
   * so a direction held at that moment cannot jam - and in lockstep a stuck
   * direction is sent to the other player too.
   */
  function applySources(): void {
    const applied = applyInputSources(localStorage, [collector]);
    assignments = applied.assignments;
    // Plugging a controller into a tablet takes the drawn one away, and
    // unplugging it brings it back: this runs on both gamepad events.
    showTouchPad = touchPadWanted(applied.padCount);
  }

  function closePauseMenu() {
    showPauseMenu = false;
    applySources();
    collector?.attach();

    // Still inside the click that dispatched 'resume', so the browser counts
    // this as a user gesture. Reached from a gamepad it is not, and the
    // request is refused - hence the swallowed rejection rather than a throw.
    if (wasFullscreen && !document.fullscreenElement) {
      deliberateFullscreenChange = true;
      stage?.requestFullscreen().catch(() => {
        deliberateFullscreenChange = false;
      });
    }
    wasFullscreen = false;
  }

  /**
   * A rebind must take effect on this machine immediately, not once the
   * server round trip confirms it: the round trip can be slow or down, and
   * a player who just saved new bindings should not keep playing on the old
   * ones with nothing on screen explaining why. The room broadcast (handled
   * by the room page's own `controlsSaved` listener) is what makes the new
   * mapping visible to everyone else, not what enables it here.
   */
  function handleControlsSaved(event: CustomEvent<{ config: ControlsConfig }>) {
    controls = event.detail.config;
    keyConfig = event.detail.config.p1.keys;
    dispatch('controlsSaved', event.detail);
    // Deliberately does not resume: saving happens on every rebind now, so
    // closing here would throw the player back into the game mid-edit.
  }

  function quitToLobby() {
    /*
     * The battery, before anything else, as both sibling rooms do.
     *
     * `teardown` persists it too, and in an ordinary two-player quit that is
     * enough: nothing has stripped our membership by then, so the write lands.
     * What it depends on is the member count - the page gives the seat up on
     * the way out only for a room of one - and a lockstep room can be down to
     * one member with a game still in hand, because a partner who leaves is
     * removed while our core goes on holding the SRAM. Saving here costs one
     * refused emit on the guest, which does not persist anyway, and makes the
     * battery stop depending on who else is still in the room.
     */
    persistSram();
    // Leave the picture before leaving the room: a lobby rendered fullscreen
    // is not what anyone asked for.
    wasFullscreen = false;
    if (document.fullscreenElement) {
      deliberateFullscreenChange = true;
      void document.exitFullscreen().catch(() => {});
    }
    closePauseMenu();
    $socket?.emit('game:stop', { roomId });
    // Said upwards rather than waited for. `game:stop` is how the server and
    // any partner hear about this, but the room page leaves on its own: a
    // room-scoped event naming a room the server no longer has is dropped in
    // silence, and then a quit that waited for `game:stopped` would never
    // come back at all. See the page's own `leaveGame`.
    dispatch('quit');
  }

  async function toggleFullscreen() {
    deliberateFullscreenChange = true;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage?.requestFullscreen();
    } catch (err) {
      deliberateFullscreenChange = false;
      logger.error('Could not toggle fullscreen', err);
    }
  }

  function onFullscreenChange() {
    const deliberate = deliberateFullscreenChange;
    deliberateFullscreenChange = false;
    isFullscreen = !!document.fullscreenElement;

    if (isFullscreen) {
      revealChrome();
      return;
    }

    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = null;
    chromeVisible = true;
    // The only way out of fullscreen we did not ask for is Escape, which in
    // this room means "open the menu" - and the keydown never reached us.
    if (!deliberate) openPauseMenu(true);
  }

  /**
   * Cheap guard on a listener that fires on every mouse move in the page: out
   * of fullscreen the toolbar is in normal flow and there is nothing to show.
   */
  function onPointerActivity() {
    if (isFullscreen) revealChrome();
  }

  /** Shows the toolbar and restarts the countdown that hides it again. */
  function revealChrome() {
    chromeVisible = true;
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = null;
    if (!isFullscreen || chromeHeld) return;
    chromeTimer = setTimeout(() => {
      chromeTimer = null;
      chromeVisible = false;
    }, CHROME_IDLE_MS);
  }

  function holdChrome() {
    chromeHeld = true;
    revealChrome();
  }

  function releaseChrome() {
    chromeHeld = false;
    revealChrome();
  }

  onDestroy(() => {
    teardown();
  });

  async function boot() {
    try {
      // Lets one query pull both players' lines for the same match.
      setLogLabels({ roomId, player: isHost ? 'p1' : 'p2' });

      statusText = 'Loading emulator core…';
      core = await loadCore();
      if (destroyed) return teardown();

      statusText = 'Locating the ROM…';
      loadedRom = await obtainRom();
      if (destroyed) return teardown();
      const rom = normaliseRom(loadedRom);
      core.loadRom(rom);

      // The shader preference is global and already set from the profile
      // page; the lockstep path simply never honoured it until now.
      const storedShader = readShaderPreference(localStorage);
      display = { ...display, shader: storedShader };

      renderer = new CanvasRenderer(canvas2d);
      renderer.draw(core);

      audio = new AudioSink();
      await audio.start(Math.round(core.sampleRate));
      if (destroyed) return teardown();
      // Ask, do not assume: a room is reached by clicking, so the context
      // is usually already running and no gesture is needed.
      needsAudioGesture = audio.needsGesture;

      assignments = loadAssignments(localStorage);
      const pads = connectedPads();
      showTouchPad = touchPadWanted(pads.length);
      collector = new InputCollector(
        { keys: keyConfig, pad: controls.p1.pad },
        resolveSources(assignments, pads).p1
      );
      collector.attach();
      // This machine has one player, whichever port they hold in the match.
      collector.setTouchPad(touchPad);

      // A pad plugged in after boot must be seen: without these, a controller
      // connected once the match is running stays dead for the session.
      window.addEventListener('gamepadconnected', applySources);
      window.addEventListener('gamepaddisconnected', applySources);

      // Battery saves are part of the emulated machine, so they must be in
      // place before the session starts: the host's state is what both peers
      // adopt, and loading SRAM afterwards would change one machine and not
      // the other. Only the host loads - the guest inherits it in that state.
      if (isHost) await loadSram();
      if (destroyed) return teardown();

      statusText = 'Connecting to the other player…';
      phase = 'waiting';
      await joinRelay();
      if (destroyed) return teardown();

      transport = new SocketTransport($socket as never, roomId);

      /*
       * Optional simulated distance, from `?lag=ping[,jitter[,loss]]`.
       *
       * Two windows on one desktop reach the relay over loopback, so a local
       * session runs at a latency no real pair will ever see - which makes the
       * only question worth asking, how the game *feels* at a given input
       * delay, untestable without a second house. Set it per window and the
       * two halves add up the way the relay makes them add up in production.
       *
       * A query parameter rather than a console call because the delay is sized
       * during the handshake: anything applied afterwards is already too late
       * for the number that matters.
       */
      const lag = parseLag(new URLSearchParams(window.location.search).get('lag'));
      if (lag) {
        // Warn, not debug. A session quietly running on a link other than the
        // real one invalidates every conclusion drawn from it, and nothing else
        // on screen would say so.
        logger.warn('Simulating network distance', lag);
        transport = new LagTransport(transport, lag);
      }

      session = new NetplaySession({
        core,
        transport,
        playerIndex: isHost ? 0 : 1,
        isHost,
        // Both peers must agree on the cartridge before a single frame runs.
        romCrc: romCrc32(rom),
        // The machine's own cadence, not an assumption. A PAL cartridge runs at
        // 50.007Hz and its frame is 20ms, which changes both how many frames a
        // round trip needs and what one frame of delay costs the player.
        fps: core.fps || undefined,
        // Left unset so the host sizes it from the link it actually measures.
        // A hardcoded guess gave 5 frames on every session: fine at 62ms,
        // and one stall per frame at the 145ms the link later drifted to.
        inputDelay: inputDelay || undefined,
        readLocalInput: () => collector!.read(),
        onEvent: handleEvent,
        onFrame: () => {
          renderer!.draw(core!);
          audio!.push(core!.audio());
        }
      });

      // The session declares this hook rather than calling core.reset() itself:
      // NetplayCore does not require a reset, so a core that has none simply
      // leaves it null. Ours has one, so hand it over.
      session.coreReset = () => core!.reset();

      pushRememberedLatencyMode();
      applyLatencyMode();

      governor = new FrameGovernor(session, {
        fps: core.fps || 60.0988,
        onSlice: (ran, stalled) => {
          setStalling(stalled && ran === 0);
          stats = session!.getStats();
          checkRendererHealth();
        }
      });

      // The server broadcasts a load to everyone in the room. Only the host
      // acts on it: it adopts the state and reseeds the session, and the guest
      // receives that state through the netplay protocol like any resync.
      // Applying it on both sides independently would put them on two machines
      // that merely started from the same bytes.
      $socket?.on('game:loaded', onSaveLoaded);

      installDebugHandle();

      session.start();
      governor.start();

      // Try to upgrade to GL now, after the session is running rather than
      // before joinRelay(): loadShaderPreset does two sequential fetches to a
      // third-party CDN with no timeout, and doing that before the relay join
      // would delay the handshake - and the other player's wait in `waiting` -
      // by however long a slow CDN takes, for a reason that has nothing to do
      // with them. Not awaited: onFrame above closes over the mutable
      // `renderer` binding, so a later swap is picked up, and applyShader is
      // already re-entrancy-safe through shaderSwapToken.
      if (storedShader) void applyShader(storedShader);

      startDiagnostics();
      // Every 30s and on the way out: a battery save that is only written at
      // teardown is lost whenever a tab is closed abruptly.
      sramTimer = setInterval(persistSram, 30000);
    } catch (err) {
      logger.error('Lockstep boot failed', err);
      errorText = err instanceof Error ? err.message : String(err);
      phase = 'error';
    }
  }

  /**
   * Lockstep failures are timing- and pad-shaped: the only way to tell "the key
   * never arrived" from "the pad never left" is to read both at the same
   * instant from a live session. See e2e/probe-lockstep.mjs.
   */
  function installDebugHandle() {
    const w = window as unknown as Record<string, any>;

    // sessionStorage, not a window field: a full page reload wipes window
    // state, so a counter kept there reads as "first boot" after exactly the
    // event it is supposed to detect.
    const boots = Number(sessionStorage.getItem('znetBoots') ?? '0') + 1;
    sessionStorage.setItem('znetBoots', String(boots));
    w.__znetBoots = boots;

    /*
     * Read-only counters, in every build.
     *
     * A lockstep failure looks the same from outside whatever its cause - a
     * black screen - and these numbers are the only thing separating "no
     * frames are running" from "frames run but nothing renders" from "the
     * peers disagree". Withholding them in production meant every report from
     * a deployed build had to be diagnosed by guesswork.
     *
     * The live session, core and collector stay development-only: those are
     * handles that can change emulation, not observations of it.
     */
    w.__znetStats = () => ({
      boot: boots,
      phase,
      state: session?.state ?? null,
      videoSize: core ? `${core.videoFrame().width}x${core.videoFrame().height}` : null,
      ...(session?.getStats() ?? {})
    });

    /*
     * The one writable handle in a production build, and a deliberate
     * exception to the rule above.
     *
     * Input latency is a budget the two players share rather than one each
     * pays: a frame only needs the peer's pad from `Dpeer` frames back, which
     * the peer could only send once it held ours from `Dours` frames before
     * that, so sixty frames per second survives on any split where
     * `Dhost + Dguest >= rtt / frameMs`. A player on a game that reads frame by
     * frame can take three frames while the other takes nine, and neither has
     * to cover the one-way trip alone.
     *
     * Which split is worth having is a question about how the game feels, so it
     * cannot be answered anywhere but on a real link in a real match. Both
     * players call this, each with their own number. Calling it pins the delay
     * for this peer, so the handshake's measurement will not undo it; a resync
     * still re-imposes the host's value on the guest, because priming the
     * startup pads is the one place the two really must agree.
     */
    w.__znetDelay = (frames?: number) => {
      if (!session) return null;
      if (typeof frames === 'number') session.setInputDelay(frames);
      return session.inputDelay;
    };

    if (!import.meta.env.DEV) return;

    w.__znetEvents = [];
    w.__znet = {
      boot: boots,
      session,
      collector,
      core,
      readPad: () => collector!.read(),
      stats: () => session!.getStats()
    };
  }

  /**
   * One line a second describing whether the session is actually moving.
   *
   * Every failure in this mode looks the same on screen - black, or a frozen
   * picture - and these five numbers separate the causes that are otherwise
   * indistinguishable:
   *
   *   fps        frames actually executed in the last second
   *   padsAhead  frames of input held for [us, them]; a remote 0 means the
   *              pads are not arriving, which is a transport problem
   *   stalls     waiting on a pad that has not come
   *   resyncs    the peers disagreed and the host reseeded the session
   *   video      the geometry the core is producing, so "running but blank"
   *              can be told from "not running"
   */
  function startDiagnostics() {
    diagnosticsTimer = setInterval(() => {
      if (!session) return;
      const s = session.getStats();
      const fps = s.framesRun - lastFramesRun;
      lastFramesRun = s.framesRun;

      const frame = core?.videoFrame();
      logger.info('netplay', {
        state: session.state,
        fps,
        frame: s.frame,
        padsAhead: s.padsAhead,
        stalls: s.stalls,
        stalledTicks: s.stalledTicks,
        resyncs: s.resyncs,
        desyncs: s.desyncs,
        epoch: s.epoch,
        rtt: s.rtt === null ? null : Math.round(s.rtt),
        // Shipped alongside the round trip because it is the half that decides
        // the delay: at a fixed 60ms round trip, 12ms of jitter needs more than
        // twice the delay 3ms does. Without it in the log, a report of "it felt
        // laggy" cannot be told from "the link was unsteady".
        jitter: s.jitter === null ? null : Math.round(s.jitter * 10) / 10,
        // Late frames, ours and the peer's. `fps` above is a per-second average
        // and reads a flat 50 straight through a burst of 40ms hitches, which is
        // precisely what a player reports as "it dropped frames".
        strain: s.strain,
        peerStrain: s.peerStrain,
        inputDelay: s.inputDelay,
        packets: [s.packetsSent, s.packetsReceived],
        video: frame ? `${frame.width}x${frame.height}` : null,
        hidden: typeof document !== 'undefined' ? document.hidden : null
      });
    }, 1000);
  }

  /*
   * Applies the room's trade-off to our own session.
   *
   * `low` pins the delay, which also switches off the strain loop - the two are
   * the same statement: this player would rather have the latency than let the
   * engine spend it on the other player's smoothness. `auto` cannot un-pin what
   * pinning disabled, so it takes effect on the next session rather than
   * mid-game; saying so in the log beats looking like it did nothing.
   */
  function applyLatencyMode() {
    if (!session) return;
    if (latencyMode === 'low') {
      session.setInputDelay(LOW_DELAY_FRAMES);
      logger.info('Latency mode: lowest', { frames: LOW_DELAY_FRAMES });
    } else {
      // Genuinely hands control back, rather than only changing the label. The
      // loop takes over from wherever the delay sits and converges from there.
      session.resumeAutomaticDelay();
      logger.info('Latency mode: automatic', { frames: session.inputDelay });
    }
  }

  // Re-apply on every change the creator broadcasts. Guarded on `session` so it
  // does nothing before the room has one.
  $: if (session && latencyMode) applyLatencyMode();

  /**
   * Pushes what this game was last played at, once, at boot.
   *
   * The choice is remembered per game because that is what it is about - a
   * turn-taking platformer and a fighting game want opposite answers - and it
   * lives on the creator's machine because the creator decides for the room.
   * Only sent when it disagrees with the room, so a guest joining a room already
   * set correctly costs nothing.
   */
  function pushRememberedLatencyMode() {
    if (!canSetLatency || typeof localStorage === 'undefined') return;
    const remembered = readLatencyPreference(localStorage, gameId);
    if (remembered === latencyMode) return;
    logger.info('Restoring this game\'s latency choice', { mode: remembered });
    $socket?.emit('room:setLatencyMode', { roomId, latencyMode: remembered });
  }

  /** Cycles the room's setting. Creator only; the server checks that too. */
  function cycleLatencyMode() {
    if (!canSetLatency) return;
    const next: LatencyMode = latencyMode === 'low' ? 'auto' : 'low';
    // Remembered against the game, because that is what the choice is about.
    if (typeof localStorage !== 'undefined') {
      writeLatencyPreference(localStorage, gameId, next);
    }
    $socket?.emit('room:setLatencyMode', { roomId, latencyMode: next });
  }

  /** Fetches this game's battery save and puts it in the machine. */
  function loadSram(): Promise<void> {
    return new Promise((resolve) => {
      const sock = $socket;
      if (!sock) return resolve();

      const done = setTimeout(() => {
        sock.off('game:sramLoaded', onLoaded);
        resolve();
      }, 5000);

      const onLoaded = (payload: { sramData?: string | null }) => {
        clearTimeout(done);
        sock.off('game:sramLoaded', onLoaded);
        try {
          if (payload?.sramData && core) {
            const bytes = decodeSram(payload.sramData);
            core.loadSram(bytes);
            logger.info('Battery save restored', { bytes: bytes.length });
          }
        } catch (err) {
          logger.error('Could not restore the battery save', err);
        }
        resolve();
      };

      sock.on('game:sramLoaded', onLoaded);
      sock.emit('game:loadSram', { roomId });
    });
  }

  /**
   * Persists the battery save.
   *
   * Host only: both machines hold identical SRAM by construction, so having
   * both write would double the traffic to store the same bytes twice.
   */
  function persistSram() {
    if (!isHost || !core || !$socket) return;
    const sramData = encodeSram(core);
    if (!sramData) return;

    $socket.emit('game:saveSram', { roomId, sramData });
  }

  function onSaveLoaded(payload: { saveData?: string; name?: string }) {
    if (!session || !payload?.saveData) return;

    if (!isHost) {
      // Nothing to do but wait: the host is about to hand us the machine.
      statusText = 'Loading save…';
      return;
    }

    try {
      const bytes = fromBase64(payload.saveData);
      if (session.loadAuthoritativeState(bytes, `save "${payload.name ?? ''}"`)) {
        audio?.flush();
        logger.info('Loaded save and reseeded the session', { name: payload.name });
      }
    } catch (err) {
      logger.error('Could not decode the save', err);
    }
  }

  /**
   * Restarts the machine on both peers.
   *
   * The same manoeuvre as loading a save, and for the same reason: the host
   * restarts, reseeds the session, and the guest is handed the new state
   * through the ordinary resync path. Nothing is sent through the room server
   * - only the host is offered the button (see `canReset` below), so there is
   * no guest press to relay.
   */
  function resetGame(): void {
    if (!session) return;
    if (session.resetAuthoritative()) {
      audio?.flush();
      logger.info('Restarted the machine and reseeded the session');
    }
  }

  /**
   * A refusal from the relay, which is terminal by nature: the seat or the
   * room is gone, and no amount of waiting brings it back. Distinct from a
   * quiet link, which does come back on its own.
   */
  function onRelayError(payload: { roomId?: string; code?: string; message?: string }) {
    if (payload?.roomId && payload.roomId !== roomId) return;
    linkLost = false;
    errorText = payload?.message ?? 'The netplay session ended';
    phase = 'error';
    logger.error('The relay refused the session', payload);
  }

  /**
   * The other player's grace period ran out, or they left on purpose.
   *
   * Only emitted from `handleLeaveRoom`, never on a bare socket drop, so
   * unlike `znet:peer-left` it never fires for the transient blips this room
   * is built to ride out. Once it does fire the departure is final, so the
   * recoverable "connection lost" badge would be lying if left showing.
   */
  function onPlayerLeft() {
    linkLost = false;
    errorText = 'The other player left the game.';
    phase = 'error';
    logger.info('The other player left; ending the session');
  }

  /**
   * Gets the room's ROM from the player's own machine.
   *
   * The quiet path covers the common case - a folder picked once, or a game
   * already loaded this session - and only falls through to asking when it
   * genuinely cannot find the file. Boot parks here rather than failing:
   * a guest who has the cartridge under another name is one gesture away from
   * playing, and erroring out would send them back to the lobby for nothing.
   */
  async function obtainRom(): Promise<Uint8Array> {
    if (!gameCrc32) {
      throw new Error('This room predates local ROMs; the host must re-add the game to their library.');
    }

    const found = await resolveQuietly(gameCrc32);
    if (found) {
      logger.info(`Loaded the ROM from this machine (${found.byteLength} bytes)`, { crc32: gameCrc32 });
      return found;
    }

    // The guest asks the host before it asks the player. The host has the
    // cartridge by definition, and sending someone away to find a file they may
    // not have is the end of the session.
    if (!isHost) {
      try {
        statusText = 'Receiving the ROM from the host…';
        const rom = await receiveRom({
          socket: $socket as never,
          roomId,
          expectedCrc32: gameCrc32,
          onProgress: (done, total) => (romTransfer = { direction: 'in', done, total })
        });
        romTransfer = null;
        remember(rom);
        logger.info(`Received the ROM from the host (${rom.byteLength} bytes)`, { crc32: gameCrc32 });
        return rom;
      } catch (err) {
        romTransfer = null;
        // Not fatal: the player may well have the file, so fall through to
        // asking rather than dropping them back into the lobby.
        logger.warn('The host could not send the ROM', err);
      }
    }

    logger.info('No local copy found; asking the player', { crc32: gameCrc32 });
    statusText = 'Waiting for you to locate the ROM…';
    return new Promise<Uint8Array>((resolve) => {
      romPrompt = (bytes) => {
        romPrompt = null;
        statusText = 'Loading the ROM…';
        resolve(bytes);
      };
    });
  }

  /**
   * Answers a guest that has no copy of the cartridge.
   *
   * Sending happens off the frame loop, a chunk at a time: lockstep runs no
   * faster than its slowest peer, so a host that stutters pushing four
   * megabytes into a socket stalls the guest it is helping.
   */
  async function onRomRequested(data: { roomId: string; from: string }) {
    if (data?.roomId !== roomId || !isHost) return;

    const rom = loadedRom ?? (gameCrc32 ? await resolveQuietly(gameCrc32) : null);
    if (!rom) {
      logger.warn('A guest asked for the ROM but this machine has no copy either');
      $socket?.emit('rom:unavailable', {
        roomId,
        to: data.from,
        reason: 'The host does not have this ROM either'
      });
      return;
    }

    logger.info(`Sending the ROM to a guest (${rom.byteLength} bytes)`);
    await sendRom({
      socket: $socket as never,
      roomId,
      to: data.from,
      rom,
      onProgress: (done, total) => (romTransfer = { direction: 'out', done, total }),
      // A frame is 16ms; yielding to the macrotask queue between chunks keeps
      // the emulator's slice from being pushed aside by the transfer.
      pause: () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    });
    romTransfer = null;
    logger.info('Finished sending the ROM');
  }

  /**
   * Claims a player slot before any netplay traffic flows. The server decides
   * the slot, so a reconnecting player cannot end up driving the wrong
   * controller port.
   */
  function joinRelay(): Promise<void> {
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

  function handleEvent(event: SessionEvent) {
    const w = window as unknown as Record<string, any>;
    if (Array.isArray(w.__znetEvents)) {
      w.__znetEvents.push({ t: Date.now(), ...event, frame: session?.currentFrame });
    }
    switch (event.type) {
      case 'state':
        if (event.message === 'running') {
          phase = 'playing';
          statusText = '';
          // Once, and only here: 'running' comes back after a resync too, and
          // re-sending this would rewind a match that had moved on.
          if (resumeSaveId) {
            $socket?.emit('game:load', { roomId, saveId: resumeSaveId });
            resumeSaveId = null;
          }
        } else if (event.message === 'syncing') {
          statusText = 'Synchronising with the host…';
        } else if (event.message === 'resyncing') {
          statusText = 'Resynchronising…';
        }
        break;
      case 'resync-start':
        // The audio still queued belongs to a timeline that no longer exists.
        audio?.flush();
        lastResyncAt = Date.now();
        logger.warn('Resync started', event.message);
        break;
      case 'desync':
        logger.warn('Desync detected', event.message);
        break;
      case 'link-lost':
        linkLost = true;
        logger.warn('The link went quiet', event.message);
        break;
      case 'link-restored':
        linkLost = false;
        logger.info('The link is back; play resumes');
        break;
      case 'error':
        errorText = event.message ?? 'Netplay failed';
        phase = 'error';
        break;
    }
    stats = session?.getStats() ?? null;
  }

  function setStalling(active: boolean) {
    stalling = active;

    if (!active) {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
      stallVisible = false;
      return;
    }

    if (stallTimer || stallVisible) return;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      stallVisible = true;
    }, STALL_VISIBLE_AFTER_MS);
  }

  /**
   * Toggles P1's gamepad between "every free controller" and "none".
   *
   * Lockstep has only one local player per machine, so this shortcut only
   * ever has two positions to offer.
   */
  function cycleGamepadSource() {
    const next = assignments.p1.gamepad === null ? 'auto' : null;
    // Written first, then re-read through applySources(): storage is the one
    // place this preference lives, and going through the same path as a
    // replug leaves a single description of "what does P1 listen to now".
    saveAssignments(localStorage, { ...assignments, p1: { ...assignments.p1, gamepad: next } });
    applySources();
  }

  /**
   * Takes the assignment and the language as parameters rather than reading
   * them off the closure: Svelte 4 derives a template expression's
   * dependencies from the identifiers written in it, so `gamepadLabel()`
   * alone compiled to a one-time initialisation and the menu item kept the
   * text it was born with - through both a toggle and a language change.
   */
  function gamepadLabel(current: Assignments, lang: Language): string {
    return current.p1.gamepad === null
      ? t(lang, 'noController')
      : t(lang, 'allFreeControllers');
  }

  async function enableAudio() {
    try {
      await audio?.resume();
    } catch (err) {
      logger.error('Could not start audio', err);
    }
    // Re-read rather than clear: if resume failed the button has to stay, or
    // the player is left with silence and nothing to click.
    needsAudioGesture = audio?.needsGesture ?? false;
  }

  function teardown() {
    destroyed = true;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = null;
    persistSram();
    if (sramTimer) clearInterval(sramTimer);
    sramTimer = null;
    $socket?.off('game:loaded', onSaveLoaded);
    $socket?.off('rom:request', onRomRequested);
    $socket?.off('znet:error', onRelayError);
    $socket?.off('player:left', onPlayerLeft);
    if (diagnosticsTimer) clearInterval(diagnosticsTimer);
    diagnosticsTimer = null;
    window.removeEventListener('gamepadconnected', applySources);
    window.removeEventListener('gamepaddisconnected', applySources);
    governor?.stop();
    session?.close();
    collector?.detach();
    void audio?.stop();
    core?.dispose();
    renderer?.dispose();
    renderer = null;
    governor = null;
    session = null;
    transport = null;
    collector = null;
    audio = null;
    core = null;
  }

  // Depends on `stats` so it re-evaluates every governor slice; keyed only on
  // lastResyncAt it would latch on and the badge would never clear.
  $: recentlyResynced = !!stats && lastResyncAt > 0 && Date.now() - lastResyncAt < 3000;
</script>

<div
  class="lockstep"
  class:paused={showPauseMenu}
  class:touch={showTouchPad}
  class:chrome-hidden={isFullscreen && !chromeVisible}
  bind:this={stage}
>
  <!-- The transfer banner and the ROM prompt live inside .lockstep rather than
       beside it: both are fixed overlays, so their position is unchanged, but
       as descendants of the fullscreen element they still render once a player
       goes fullscreen. A host serving a ROM to a guest who joins mid-match
       would otherwise watch a silent transfer. -->
  {#if romTransfer}
    <div class="rom-transfer">
      <span>
        {romTransfer.direction === 'in'
          ? 'Receiving the ROM from the host'
          : 'Sending the ROM to the other player'}
      </span>
      <progress value={romTransfer.done} max={romTransfer.total}></progress>
      <span class="rom-transfer-count">
        {Math.round((romTransfer.done / Math.max(1, romTransfer.total)) * 100)}%
      </span>
    </div>
  {/if}

  {#if romPrompt}
    <LocateRom checksum={gameCrc32 ?? ''} title={gameTitle} on:found={(e) => romPrompt?.(e.detail)} />
  {/if}

  <!--
    Double-click toggles fullscreen, the way a video player does. It is not a
    menu entry because Escape has to reach the menu, and the browser keeps
    Escape for leaving fullscreen. Alt+Enter still works.
  -->
  <div
    class="screen"
    class:stalling={stallVisible}
    on:dblclick={toggleFullscreen}
    role="presentation"
    use:fitToBox={displayRatio}
  >
    <canvas bind:this={canvas2d} class:inactive={usingGl} width="256" height="224"></canvas>
    <canvas bind:this={canvasGl} class:inactive={!usingGl} width="256" height="224"></canvas>

    {#if shaderNotice}
      <p class="shader-notice">{shaderNotice}</p>
    {/if}

    {#if phase !== 'playing'}
      <div class="overlay">
        {#if phase === 'error'}
          <p class="error">{errorText}</p>
          <button class="action" on:click={() => goto('/')}>Back to the lobby</button>
        {:else}
          <div class="spinner"></div>
          <p>{statusText}</p>
        {/if}
      </div>
    {:else if linkLost}
      <!-- Not an error screen: this clears itself when packets resume. -->
      <div class="badge badge-warn">
        Connection lost — play resumes as soon as it is back
      </div>
    {:else if stallVisible}
      <!-- Lockstep's honest failure mode: say what is happening rather than
           inventing frames the other player has not agreed to. -->
      <div class="badge">Waiting for the other player…</div>
    {:else if recentlyResynced}
      <div class="badge">Resynchronised</div>
    {/if}
  </div>

  <div
    class="bar"
    role="group"
    aria-label="Emulator controls"
    on:mouseenter={holdChrome}
    on:mouseleave={releaseChrome}
    on:focusin={holdChrome}
    on:focusout={releaseChrome}
  >
    {#if needsAudioGesture}
      <button class="action" on:click={enableAudio}>Enable sound</button>
    {/if}
    <!--
      Controls moved into the pause menu; readouts stayed. A live round-trip
      number is the only visible sign of connection quality, and pausing does
      not stop a lockstep session anyway, so hiding it behind a menu would
      hide exactly the thing you want while playing.
    -->
    <button class="action" on:click={() => openPauseMenu(isFullscreen)}>☰ Menu (Esc)</button>
    {#if stats}
      <span class="summary">
        {stats.rtt ? `${Math.round(stats.rtt)} ms` : '— ms'}{stats.jitter === null
          ? ''
          : ` ±${stats.jitter.toFixed(1)}`} · delay {stats.inputDelay}f
      </span>
    {/if}
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
      <TouchControls pad={touchPad} />
    </div>
  {/if}

  {#if showPauseMenu}
    <!-- port 2 is the remote peer here, never a second local player -->
    <PauseMenu
      localPlayer2Playable={false}
      {roomId}
      {gameId}
      {keyConfig}
      {controls}
      {display}
      {showStats}
      {latencyMode}
      {canSetLatency}
      canReset={isHost}
      gamepadLabel={gamepadLabel(assignments, $language)}
      emulator={saveAdapter}
      on:resume={closePauseMenu}
      on:quit={quitToLobby}
      on:reset={resetGame}
      on:display={(e) => void onDisplayChange(e.detail)}
      on:stats={() => (showStats = !showStats)}
      on:latency={cycleLatencyMode}
      on:gamepad={cycleGamepadSource}
      on:controlsSaved={handleControlsSaved}
    />
  {/if}

  {#if showStats && stats}
    <dl class="stats" on:mouseenter={holdChrome} on:mouseleave={releaseChrome}>
      <div><dt>Frame</dt><dd>{stats.frame}</dd></div>
      <div><dt>Round trip</dt><dd>{stats.rtt ? `${Math.round(stats.rtt)} ms` : '—'}</dd></div>
      <!-- Next to the round trip on purpose: latency alone costs a one-off offset
           between the peers, and it is the variation that leaves a pad late for
           the frame that needed it. At a fixed 60ms round trip, a link with 12ms
           of jitter needs more than twice the delay of one with 3ms. -->
      <div>
        <dt>Jitter</dt>
        <dd>{stats.jitter === null ? '—' : `${stats.jitter.toFixed(1)} ms`}</dd>
      </div>
      <div><dt>Input delay</dt><dd>{stats.inputDelay} frames</dd></div>
      <div><dt>Stalls</dt><dd>{stats.stalls}</dd></div>
      <div><dt>Desyncs</dt><dd>{stats.desyncs}</dd></div>
      <div><dt>Resyncs</dt><dd>{stats.resyncs}</dd></div>
      <div><dt>Packets in / out</dt><dd>{stats.packetsReceived} / {stats.packetsSent}</dd></div>
    </dl>
  {/if}
</div>

<style>
  .rom-transfer {
    position: fixed;
    left: 50%;
    bottom: 2rem;
    transform: translateX(-50%);
    z-index: 900;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 1rem;
    border-radius: 999px;
    background: rgba(20, 20, 30, 0.92);
    border: 1px solid #2c2c3c;
    color: #e6e6f0;
    font-size: 0.85rem;
  }

  .rom-transfer progress {
    width: 160px;
    height: 6px;
  }

  .rom-transfer-count {
    color: #8b8ba3;
    font-variant-numeric: tabular-nums;
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
    .lockstep.touch .touch-zone {
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
    .lockstep.touch .bar {
      order: -1;
    }

    /* And the picture goes up, out of the pad's way, rather than staying
       centred in a box the pad now covers the bottom of. */
    .lockstep.touch .screen {
      align-items: flex-start;
    }
  }

  .lockstep {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    /* What the touch pad is positioned against in portrait. */
    position: relative;
    /* The page centres its children; claim the full height instead. */
    align-self: stretch;
    height: 100%;
    min-height: 0;
  }

  .screen {
    position: relative;
    /* Take whatever the toolbar leaves, in both directions. The ratio belongs
       to the picture inside, not to the box - that is what makes 1:1 and 4:3 a
       real choice rather than two ways of filling the same shape. */
    flex: 1;
    min-height: 0;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
    overflow: hidden;
  }

  .screen.stalling canvas {
    filter: saturate(0.4);
  }

  canvas {
    /* Sized by the fitToBox action on .screen; the fallback covers the frames
       before the first measurement. */
    width: var(--fit-width, 100%);
    height: var(--fit-height, 100%);
    /* The box already carries the intended ratio, so nothing to letterbox. */
    object-fit: fill;
    image-rendering: pixelated;
    display: block;
  }

  canvas.inactive {
    display: none;
  }

  .shader-notice {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    margin: 0;
    padding: 0.35rem 0.6rem;
    background: rgba(0, 0, 0, 0.6);
    color: #e0b040;
    font-size: 0.8rem;
    text-align: center;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    background: rgba(0, 0, 0, 0.75);
    color: #eee;
    text-align: center;
    padding: 1rem;
  }

  .error {
    color: #ff8f8f;
    max-width: 40ch;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .badge {
    position: absolute;
    left: 50%;
    bottom: 1rem;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
    padding: 0.35rem 0.9rem;
    border-radius: 999px;
    font-size: 0.85rem;
  }

  .badge-warn {
    background: rgba(150, 75, 0, 0.9);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .action {
    background: #2a2a3a;
    color: #eee;
    border: 1px solid #3d3d52;
    border-radius: 6px;
    padding: 0.35rem 0.8rem;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .action:hover {
    background: #34344a;
  }

  .summary {
    color: #9a9ab0;
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 0.5rem 1.5rem;
    width: 100%;
    max-width: 1024px;
    margin: 0;
    padding: 0.75rem 1rem;
    background: #1b1b26;
    border: 1px solid #2c2c3c;
    border-radius: 8px;
    font-size: 0.85rem;
  }

  .stats div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .stats dt {
    color: #8b8ba3;
  }

  .stats dd {
    margin: 0;
    color: #e6e6f0;
    font-variant-numeric: tabular-nums;
  }

  /* --------------------------------------------------------- fullscreen */

  .lockstep:fullscreen {
    position: relative;
    width: 100%;
    height: 100%;
    justify-content: center;
    gap: 0;
    background: #000;
    /* The layout sets `cursor: none` on every fullscreen element, which is
       right while playing and wrong while the toolbar is up: an overlay you
       cannot see the pointer over is an overlay you cannot click. */
    cursor: default;
  }

  .lockstep:fullscreen.chrome-hidden {
    cursor: none;
  }

  .lockstep:fullscreen .screen {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  /* Clear of the toolbar, which now overlays the bottom of the picture. */
  .lockstep:fullscreen .badge {
    bottom: 4.5rem;
  }

  .lockstep:fullscreen .bar,
  .lockstep:fullscreen .stats {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    transition: opacity 0.2s ease;
  }

  .lockstep:fullscreen .bar {
    bottom: 1.25rem;
    justify-content: center;
    padding: 0.5rem 0.9rem;
    border-radius: 999px;
    background: rgba(20, 20, 30, 0.92);
    border: 1px solid #2c2c3c;
  }

  .lockstep:fullscreen .stats {
    bottom: 5rem;
    width: min(1024px, 90vw);
  }

  .lockstep:fullscreen.chrome-hidden .bar,
  .lockstep:fullscreen.chrome-hidden .stats {
    opacity: 0;
    /* Also makes the picture behind it clickable again, and hands the cursor
       back to the stage rule above so it disappears with the toolbar. */
    pointer-events: none;
  }
  /*
   * The pause panel is fixed to the left edge, so it pushes nothing by itself.
   * Reserving its width here is what makes the game shrink rather than be
   * covered - and .screen's ResizeObserver re-fits the picture as the padding
   * animates, which keeps it crisp instead of scaled.
   */
  .lockstep {
    --pause-panel-width: 20rem;
    transition: padding-left 220ms cubic-bezier(0.33, 1, 0.68, 1);
  }

  .lockstep.paused {
    padding-left: var(--pause-panel-width);
  }

  /* Narrow: the panel covers instead, so there is nothing to reserve. */
  @media (max-width: 700px) {
    .lockstep.paused {
      padding-left: 0;
    }
  }
</style>
