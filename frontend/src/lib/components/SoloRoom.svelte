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
  import { onMount, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';
  import type { KeyConfig } from '$lib/types';
  import { createLogger } from '$lib/utils/logger';
  import { setLogLabels } from '$lib/utils/log-shipper';
  import LocateRom from './LocateRom.svelte';
  import { remember, resolveQuietly } from '$lib/roms/provider';
  import { VALID_SHADER_IDS } from './ShaderSelector.svelte';
  import { DEFAULT_DISPLAY, type DisplayOptions, type Renderer } from '$lib/znet';
  import {
    AudioSink,
    CanvasRenderer,
    WebglRenderer,
    loadShaderPreset,
    FrameGovernor,
    InputCollector,
    SoloSession,
    type GamepadSource,
    PsnesCore,
    loadCore,
    normaliseRom
  } from '$lib/znet';

  export let roomId: string;
  export let gameId: string;
  export let gameCrc32: string | null = null;
  export let gameTitle: string = '';
  export let keyConfig: KeyConfig;

  const logger = createLogger('SoloRoom');

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
  let audio: AudioSink | null = null;
  let collector: InputCollector | null = null;
  let session: SoloSession | null = null;
  let governor: FrameGovernor | null = null;

  let phase: 'booting' | 'playing' | 'error' = 'booting';
  let statusText = 'Loading emulator core…';
  let errorText = '';
  let needsAudioGesture = false;
  let romPrompt: ((bytes: Uint8Array) => void) | null = null;
  let loadedRom: Uint8Array | null = null;

  let display: DisplayOptions = { ...DEFAULT_DISPLAY };
  let shaderNotice: string | null = null;
  let shaderSwapToken = 0;
  let gamepadSource: GamepadSource = 'auto';

  const gamepadKey = 'psnes-gamepad-source';

  $: activeCanvas = usingGl ? canvasGl : canvas2d;
  $: if (renderer && display) renderer.setOptions(display);
  $: if (collector && keyConfig) collector.setKeyConfig(keyConfig);

  function shaderLabel(id: string): string {
    if (!id) return 'No shader';
    return id.split('/').pop() as string;
  }

  /** Drops back to the 2D renderer on its own canvas. Always succeeds. */
  function useCanvasRenderer(): void {
    renderer?.dispose();
    usingGl = false;
    // The button reads display.shader and nothing else, so leaving it set
    // would keep advertising a shader that is not running. The stored
    // preference is left alone: it is the player's choice, retried next boot.
    display = { ...display, shader: '' };
    renderer = new CanvasRenderer(canvas2d);
    renderer.setOptions(display);
    if (core) renderer.draw(core);
  }

  /**
   * Switches the renderer to run `shaderId`, or keeps 2D and says why.
   *
   * Every failure lands on a working 2D renderer plus a notice. The player is
   * never left looking at a black canvas wondering whether the game crashed.
   */
  async function applyShader(shaderId: string): Promise<void> {
    const token = ++shaderSwapToken;
    shaderNotice = null;

    if (!shaderId) {
      useCanvasRenderer();
      return;
    }

    const loaded = await loadShaderPreset(shaderId);
    if (token !== shaderSwapToken) return;

    if (!loaded.ok) {
      logger.warn('shader unavailable', { shaderId, reason: loaded.reason });
      shaderNotice = 'That shader could not be loaded; showing raw pixels.';
      useCanvasRenderer();
      return;
    }

    // The second dispose on the failure path below is safe: both renderers
    // guard every deletion and null what they delete.
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

  async function cycleShader(): Promise<void> {
    const next =
      VALID_SHADER_IDS[(VALID_SHADER_IDS.indexOf(display.shader) + 1) % VALID_SHADER_IDS.length];
    display = { ...display, shader: next };
    if (next) localStorage.setItem('psnes-shader', next);
    else localStorage.removeItem('psnes-shader');
    await applyShader(next);
  }

  /** Falls back to 2D if the GL context died mid-game. One boolean per slice. */
  function checkRendererHealth(): void {
    if (renderer instanceof WebglRenderer && renderer.unusable) {
      logger.warn('webgl context lost, falling back to 2D');
      shaderNotice = 'Hardware shaders stopped working; showing raw pixels.';
      useCanvasRenderer();
    }
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

  async function boot() {
    try {
      setLogLabels({ roomId, player: 'solo' });

      statusText = 'Loading emulator core…';
      core = await loadCore();

      statusText = 'Locating the ROM…';
      loadedRom = await obtainRom();
      core.loadRom(normaliseRom(loadedRom));

      const storedShader = localStorage.getItem('psnes-shader') || '';
      if (storedShader && !VALID_SHADER_IDS.includes(storedShader)) {
        localStorage.removeItem('psnes-shader');
      } else if (storedShader) {
        display = { ...display, shader: storedShader };
      }

      renderer = new CanvasRenderer(canvas2d);
      renderer.draw(core);

      audio = new AudioSink();
      await audio.start(Math.round(core.sampleRate));
      needsAudioGesture = true;

      const saved = localStorage.getItem(gamepadKey);
      if (saved) gamepadSource = saved === 'auto' || saved === 'off' ? saved : Number(saved);
      collector = new InputCollector(keyConfig, gamepadSource);
      collector.attach();

      session = new SoloSession({
        core,
        // pad2 stays 0: znet reads a single local source today. The pair is in
        // the signature so a second controller changes this line and nothing
        // else.
        readLocalInput: () => ({ pad1: collector!.read(), pad2: 0 }),
        onFrame: () => {
          renderer!.draw(core!);
          audio!.push(core!.audio());
        }
      });

      governor = new FrameGovernor(session, {
        fps: core.fps || 60.0988,
        onSlice: () => checkRendererHealth()
      });
      governor.start();

      phase = 'playing';
      statusText = '';

      // After the session is running, so a slow CDN cannot delay the picture.
      if (display.shader) void applyShader(display.shader);
    } catch (err) {
      logger.error('Solo boot failed', err);
      errorText = err instanceof Error ? err.message : String(err);
      phase = 'error';
    }
  }

  async function startAudio() {
    needsAudioGesture = false;
    await audio?.resume();
  }

  function teardown() {
    governor?.stop();
    governor = null;
    session = null;
    collector?.detach();
    collector = null;
    void audio?.stop();
    audio = null;
    renderer?.dispose();
    renderer = null;
    core?.dispose();
    core = null;
  }

  onMount(() => {
    void boot();
  });

  onDestroy(() => {
    teardown();
  });
</script>

<div class="solo">
  <div class="screen">
    <canvas bind:this={canvas2d} class:inactive={usingGl} width="256" height="224"></canvas>
    <canvas bind:this={canvasGl} class:inactive={!usingGl} width="256" height="224"></canvas>

    {#if shaderNotice}
      <p class="shader-notice">{shaderNotice}</p>
    {/if}

    {#if phase !== 'playing'}
      <div class="overlay">
        {#if phase === 'error'}
          <p class="error">{errorText}</p>
        {:else}
          <p>{statusText}</p>
        {/if}
      </div>
    {/if}

    {#if needsAudioGesture}
      <button class="audio-gesture" on:click={startAudio}>Click for sound</button>
    {/if}
  </div>

  <div class="toolbar">
    <button
      class="action"
      class:on={display.shader !== ''}
      on:click={cycleShader}
      title="Shader"
    >{shaderLabel(display.shader)}</button>
  </div>
</div>

{#if romPrompt}
  <LocateRom checksum={gameCrc32 ?? ''} title={gameTitle} on:found={(e) => romPrompt?.(e.detail)} />
{/if}

<style>
  .solo {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .screen {
    position: relative;
    aspect-ratio: 4 / 3;
    background: #000;
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

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
  }

  .error {
    color: #f87171;
    max-width: 32rem;
    text-align: center;
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

  .action.on {
    background: #3a4a5a;
    border-color: #667eea;
  }
</style>
