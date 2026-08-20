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
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { socket } from '$lib/api/socket';
  import type { KeyConfig } from '$lib/types';
  import { createLogger } from '$lib/utils/logger';
  import { setLogLabels } from '$lib/utils/log-shipper';
  import PauseMenu from './PauseMenu.svelte';
  import LocateRom from './LocateRom.svelte';
  import { remember, resolveQuietly } from '$lib/roms/provider';
  import { receiveRom, sendRom } from '$lib/roms/transfer';
  import { VALID_SHADER_IDS } from './ShaderSelector.svelte';
  import { DEFAULT_DISPLAY, type DisplayOptions, type Renderer } from '$lib/znet';
  import {
    AudioSink,
    CanvasRenderer,
    WebglRenderer,
    loadShaderPreset,
    FrameGovernor,
    InputCollector,
    NetplaySession,
    type GamepadSource,
    PsnesCore,
    SocketTransport,
    loadCore,
    normaliseRom,
    romCrc32,
    type SessionEvent,
    type SessionStats
  } from '$lib/znet';

  const logger = createLogger('LockstepRoom');

  export let roomId: string;
  export let gameId: string;
  /** The CRC32 of the room's ROM: how each player finds their own copy. */
  export let gameCrc32: string | undefined = undefined;
  export let gameTitle = '';
  export let isHost: boolean;
  export let keyConfig: KeyConfig;
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
  let transport: SocketTransport | null = null;
  let collector: InputCollector | null = null;
  let renderer: Renderer | null = null;
  let audio: AudioSink | null = null;

  /**
   * Which gamepad drives this window, remembered per player.
   *
   * Two windows on one machine both see the same physical pad, so without a
   * choice here one controller drives both players at once.
   */
  const gamepadKey = `znet:gamepad:${isHost ? 'p1' : 'p2'}`;
  let gamepadSource: GamepadSource = 'auto';
  let gamepadOptions: GamepadSource[] = ['auto', 'off'];

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

    if (next.shader) localStorage.setItem('psnes-shader', next.shader);
    else localStorage.removeItem('psnes-shader');
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

  $: saveAdapter = core
    ? { saveState: async () => core!.saveState(), getCanvas: () => activeCanvas }
    : null;

  $: if (renderer && display) renderer.setOptions(display);

  /** Periodic health line; see startDiagnostics. */
  let diagnosticsTimer: ReturnType<typeof setInterval> | null = null;
  let sramTimer: ReturnType<typeof setInterval> | null = null;
  let lastFramesRun = 0;

  $: if (collector && keyConfig) collector.setKeyConfig(keyConfig);

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
    if (event.key !== 'Escape' || showPauseMenu) return;
    event.preventDefault();
    openPauseMenu(!!document.fullscreenElement);
  }

  function openPauseMenu(restoreFullscreen = false) {
    if (showPauseMenu) return;
    wasFullscreen = restoreFullscreen;
    showPauseMenu = true;
    // Release every held key: the menu swallows keyups, and in lockstep a
    // stuck direction is sent to the other player too.
    collector?.detach();
  }

  function closePauseMenu() {
    showPauseMenu = false;
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

  function quitToLobby() {
    // Leave the picture before leaving the room: a lobby rendered fullscreen
    // is not what anyone asked for.
    wasFullscreen = false;
    if (document.fullscreenElement) {
      deliberateFullscreenChange = true;
      void document.exitFullscreen().catch(() => {});
    }
    closePauseMenu();
    $socket?.emit('game:stop', { roomId });
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

      statusText = 'Locating the ROM…';
      loadedRom = await obtainRom();
      const rom = normaliseRom(loadedRom);
      core.loadRom(rom);

      // The shader preference is global and already set from the home page's
      // settings modal; the lockstep path simply never honoured it until now.
      // Read-and-purge like the other two readers (P2PRoom.svelte and
      // routes/+page.svelte): a stale id left over from a delisted preset
      // (xbrz-freescale, before it was removed) is dropped here too, rather
      // than costing this reader alone a CDN round trip and a user-facing
      // notice for a value the other two would have deleted outright.
      let storedShader = localStorage.getItem('psnes-shader') || '';
      if (storedShader && !VALID_SHADER_IDS.includes(storedShader)) {
        localStorage.removeItem('psnes-shader');
        storedShader = '';
      }
      display = { ...display, shader: storedShader };

      renderer = new CanvasRenderer(canvas2d);
      renderer.draw(core);

      audio = new AudioSink();
      await audio.start(Math.round(core.sampleRate));
      // Ask, do not assume: a room is reached by clicking, so the context
      // is usually already running and no gesture is needed.
      needsAudioGesture = audio.needsGesture;

      const saved = localStorage.getItem(gamepadKey);
      if (saved) gamepadSource = saved === 'auto' || saved === 'off' ? saved : Number(saved);
      collector = new InputCollector(keyConfig, gamepadSource);
      collector.attach();
      refreshGamepadOptions();
      window.addEventListener('gamepadconnected', refreshGamepadOptions);
      window.addEventListener('gamepaddisconnected', refreshGamepadOptions);

      // Battery saves are part of the emulated machine, so they must be in
      // place before the session starts: the host's state is what both peers
      // adopt, and loading SRAM afterwards would change one machine and not
      // the other. Only the host loads - the guest inherits it in that state.
      if (isHost) await loadSram();

      statusText = 'Connecting to the other player…';
      phase = 'waiting';
      await joinRelay();

      transport = new SocketTransport($socket as never, roomId);

      session = new NetplaySession({
        core,
        transport,
        playerIndex: isHost ? 0 : 1,
        isHost,
        // Both peers must agree on the cartridge before a single frame runs.
        romCrc: romCrc32(rom),
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
        inputDelay: s.inputDelay,
        packets: [s.packetsSent, s.packetsReceived],
        video: frame ? `${frame.width}x${frame.height}` : null,
        hidden: typeof document !== 'undefined' ? document.hidden : null
      });
    }, 1000);
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
            const binary = atob(payload.sramData);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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
    const sram = core.sram();
    if (sram.length === 0) return;

    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < sram.length; i += CHUNK) {
      binary += String.fromCharCode(...sram.subarray(i, i + CHUNK));
    }
    $socket.emit('game:saveSram', { roomId, sramData: btoa(binary) });
  }

  function onSaveLoaded(payload: { saveData?: string; name?: string }) {
    if (!session || !payload?.saveData) return;

    if (!isHost) {
      // Nothing to do but wait: the host is about to hand us the machine.
      statusText = 'Loading save…';
      return;
    }

    try {
      const binary = atob(payload.saveData);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      if (session.loadAuthoritativeState(bytes, `save "${payload.name ?? ''}"`)) {
        audio?.flush();
        logger.info('Loaded save and reseeded the session', { name: payload.name });
      }
    } catch (err) {
      logger.error('Could not decode the save', err);
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

  function refreshGamepadOptions() {
    const connected = collector?.connectedGamepads() ?? [];
    gamepadOptions = ['auto', 'off', ...connected];
  }

  function cycleGamepadSource() {
    const i = gamepadOptions.findIndex((o) => o === gamepadSource);
    gamepadSource = gamepadOptions[(i + 1) % gamepadOptions.length];
    collector?.setGamepadSource(gamepadSource);
    localStorage.setItem(gamepadKey, String(gamepadSource));
  }

  function gamepadLabel(source: GamepadSource) {
    if (source === 'auto') return 'all pads';
    if (source === 'off') return 'keyboard only';
    return `pad ${source}`;
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
    window.removeEventListener('gamepadconnected', refreshGamepadOptions);
    window.removeEventListener('gamepaddisconnected', refreshGamepadOptions);
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

  <div class="screen" class:stalling={stallVisible}>
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
        {stats.rtt ? `${Math.round(stats.rtt)} ms` : '— ms'} · delay {stats.inputDelay}f
      </span>
    {/if}
  </div>

  {#if showPauseMenu}
    <PauseMenu
      {roomId}
      {gameId}
      {keyConfig}
      {display}
      {isFullscreen}
      scanlinesAvailable={!usingGl}
      {showStats}
      gamepadLabel={gamepadLabel(gamepadSource)}
      emulator={saveAdapter}
      on:resume={closePauseMenu}
      on:quit={quitToLobby}
      on:display={(e) => void onDisplayChange(e.detail)}
      on:fullscreen={toggleFullscreen}
      on:stats={() => (showStats = !showStats)}
      on:gamepad={cycleGamepadSource}
      on:saved={(e) => { keyConfig = e.detail.config; closePauseMenu(); }}
    />
  {/if}

  {#if showStats && stats}
    <dl class="stats" on:mouseenter={holdChrome} on:mouseleave={releaseChrome}>
      <div><dt>Frame</dt><dd>{stats.frame}</dd></div>
      <div><dt>Round trip</dt><dd>{stats.rtt ? `${Math.round(stats.rtt)} ms` : '—'}</dd></div>
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

  .lockstep {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
  }

  .screen {
    position: relative;
    width: 100%;
    max-width: 1024px;
    aspect-ratio: 4 / 3;
    background: #000;
    border-radius: 8px;
    overflow: hidden;
  }

  .screen.stalling canvas {
    filter: saturate(0.4);
  }

  canvas {
    width: 100%;
    height: 100%;
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
    max-width: none;
    width: 100%;
    height: 100%;
    /* The canvas keeps its own object-fit, set by the active renderer from the
       display options, so 'Fit' still letterboxes and 'Stretch' still fills. */
    aspect-ratio: auto;
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
</style>
