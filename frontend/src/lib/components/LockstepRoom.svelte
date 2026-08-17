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
    suggestInputDelay,
    type SessionEvent,
    type SessionStats
  } from '$lib/znet';

  const logger = createLogger('LockstepRoom');

  export let roomId: string;
  export let isHost: boolean;
  export let keyConfig: KeyConfig;
  /** Frames of input delay. 0 asks for a value derived from the measured RTT. */
  export let inputDelay = 0;

  let canvas: HTMLCanvasElement;
  let phase: 'loading' | 'waiting' | 'playing' | 'error' = 'loading';
  let statusText = 'Loading core…';
  let errorText = '';
  let needsAudioGesture = false;
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
  let stalling = false;
  let lastResyncAt = 0;

  /** Periodic health line; see startDiagnostics. */
  let diagnosticsTimer: ReturnType<typeof setInterval> | null = null;
  let lastFramesRun = 0;

  $: if (collector && keyConfig) collector.setKeyConfig(keyConfig);

  onMount(() => {
    void boot();
  });

  onDestroy(() => {
    teardown();
  });

  async function boot() {
    try {
      // Lets one query pull both players' lines for the same match.
      setLogLabels({ roomId, player: isHost ? 'p1' : 'p2' });

      statusText = 'Loading emulator core…';
      core = await loadCore();

      statusText = 'Downloading ROM…';
      const rom = normaliseRom(new Uint8Array(await fetchRom()));
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
        inputDelay: inputDelay || suggestInputDelay(120),
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
          stalling = stalled && ran === 0;
          stats = session!.getStats();
        }
      });

      installDebugHandle();

      session.start();
      governor.start();
      startDiagnostics();
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

  async function fetchRom(): Promise<ArrayBuffer> {
    const response = await fetch(`/api/games/room/${roomId}/rom`, { credentials: 'include' });
    if (!response.ok) throw new Error(`Could not download the ROM (HTTP ${response.status})`);
    return response.arrayBuffer();
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

<div class="lockstep">
  <div class="screen" class:stalling>
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
    {:else if stalling}
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
    <button class="action" on:click={() => (showStats = !showStats)}>
      {showStats ? 'Hide' : 'Show'} netplay stats
    </button>
    {#if stats}
      <span class="summary">
        {stats.rtt ? `${Math.round(stats.rtt)} ms` : '— ms'} · delay {stats.inputDelay}f
      </span>
    {/if}
  </div>

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
