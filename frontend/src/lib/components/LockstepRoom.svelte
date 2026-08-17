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
  import { socket } from '$lib/api/socket';
  import type { KeyConfig } from '$lib/types';
  import { createLogger } from '$lib/utils/logger';
  import { setLogLabels } from '$lib/utils/log-shipper';
  import PauseMenu from './PauseMenu.svelte';
  import LocateRom from './LocateRom.svelte';
  import { resolveQuietly } from '$lib/roms/provider';
  import { DEFAULT_DISPLAY, type DisplayOptions } from '$lib/znet';
  import {
    AudioSink,
    CanvasRenderer,
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

  let canvas: HTMLCanvasElement;
  let phase: 'loading' | 'waiting' | 'playing' | 'error' = 'loading';
  let statusText = 'Loading core…';
  let errorText = '';
  let needsAudioGesture = false;
  /** Set while the boot is parked waiting for the player to point at a file. */
  let romPrompt: ((bytes: Uint8Array) => void) | null = null;
  let showStats = false;

  let core: PsnesCore | null = null;
  let session: NetplaySession | null = null;
  let governor: FrameGovernor | null = null;
  let transport: SocketTransport | null = null;
  let collector: InputCollector | null = null;
  let renderer: CanvasRenderer | null = null;
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

  let showPauseMenu = false;
  let display: DisplayOptions = { ...DEFAULT_DISPLAY };

  /**
   * What SavesManager needs from an emulator: a state it can store.
   *
   * Saving reads the machine without touching it, so it needs no coordination
   * with the other player - unlike loading, which goes through the session so
   * both peers land on the same machine.
   */
  $: saveAdapter = core ? { saveState: async () => core!.saveState() } : null;

  $: if (renderer && display) renderer.setOptions(display);

  /** Periodic health line; see startDiagnostics. */
  let diagnosticsTimer: ReturnType<typeof setInterval> | null = null;
  let sramTimer: ReturnType<typeof setInterval> | null = null;
  let lastFramesRun = 0;

  $: if (collector && keyConfig) collector.setKeyConfig(keyConfig);

  onMount(() => {
    void boot();
    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  });

  function onGlobalKey(event: KeyboardEvent) {
    if (event.key !== 'Escape' || showPauseMenu) return;
    event.preventDefault();
    showPauseMenu = true;
    // Release every held key: the menu swallows keyups, and in lockstep a
    // stuck direction is sent to the other player too.
    collector?.detach();
  }

  function closePauseMenu() {
    showPauseMenu = false;
    collector?.attach();
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
      const rom = normaliseRom(await obtainRom());
      core.loadRom(rom);

      renderer = new CanvasRenderer(canvas);
      renderer.draw(core);

      audio = new AudioSink();
      await audio.start(Math.round(core.sampleRate));
      needsAudioGesture = true;

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
    await audio?.resume();
    needsAudioGesture = false;
  }

  function teardown() {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    persistSram();
    if (sramTimer) clearInterval(sramTimer);
    sramTimer = null;
    $socket?.off('game:loaded', onSaveLoaded);
    if (diagnosticsTimer) clearInterval(diagnosticsTimer);
    diagnosticsTimer = null;
    window.removeEventListener('gamepadconnected', refreshGamepadOptions);
    window.removeEventListener('gamepaddisconnected', refreshGamepadOptions);
    governor?.stop();
    session?.close();
    collector?.detach();
    void audio?.stop();
    core?.dispose();
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

{#if romPrompt}
  <LocateRom checksum={gameCrc32 ?? ''} title={gameTitle} on:found={(e) => romPrompt?.(e.detail)} />
{/if}

<div class="lockstep">
  <div class="screen" class:stalling={stallVisible}>
    <canvas bind:this={canvas} width="256" height="224"></canvas>

    {#if phase !== 'playing'}
      <div class="overlay">
        {#if phase === 'error'}
          <p class="error">{errorText}</p>
        {:else}
          <div class="spinner"></div>
          <p>{statusText}</p>
        {/if}
      </div>
    {:else if stallVisible}
      <!-- Lockstep's honest failure mode: say what is happening rather than
           inventing frames the other player has not agreed to. -->
      <div class="badge">Waiting for the other player…</div>
    {:else if recentlyResynced}
      <div class="badge">Resynchronised</div>
    {/if}
  </div>

  <div class="bar">
    {#if needsAudioGesture}
      <button class="action" on:click={enableAudio}>Enable sound</button>
    {/if}
    <button class="action" on:click={cycleGamepadSource} title="Which gamepad drives this player">
      🎮 {gamepadLabel(gamepadSource)}
    </button>
    <button class="action" on:click={() => (showPauseMenu = true)}>☰ Menu (Esc)</button>
    <button
      class="action"
      class:on={display.scanlines}
      on:click={() => (display = { ...display, scanlines: !display.scanlines })}
    >Scanlines</button>
    <button
      class="action"
      on:click={() => (display = { ...display, pixelPerfect: !display.pixelPerfect })}
    >{display.pixelPerfect ? 'Sharp' : 'Smooth'}</button>
    <button
      class="action"
      on:click={() =>
        (display = { ...display, aspect: display.aspect === 'original' ? 'stretch' : 'original' })}
    >{display.aspect === 'original' ? 'Fit' : 'Stretch'}</button>
    <button class="action" on:click={() => (showStats = !showStats)}>
      {showStats ? 'Hide' : 'Show'} netplay stats
    </button>
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
      emulator={saveAdapter}
      on:resume={closePauseMenu}
      on:quit={() => { closePauseMenu(); $socket?.emit('game:stop', { roomId }); }}
      on:saved={(e) => { keyConfig = e.detail.config; closePauseMenu(); }}
    />
  {/if}

  {#if showStats && stats}
    <dl class="stats">
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

  .action.on {
    background: #667eea;
    color: #fff;
    border-color: #667eea;
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
</style>
