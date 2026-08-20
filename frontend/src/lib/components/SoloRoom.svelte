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
  import { goto } from '$app/navigation';
  import type { KeyConfig } from '$lib/types';
  import { createLogger } from '$lib/utils/logger';
  import { setLogLabels } from '$lib/utils/log-shipper';
  import { socket } from '$lib/api/socket';
  import LocateRom from './LocateRom.svelte';
  import { remember, resolveQuietly } from '$lib/roms/provider';
  import { VALID_SHADER_IDS } from './ShaderSelector.svelte';
  import PauseMenu from './PauseMenu.svelte';
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
    normaliseRom,
    aspectRatioOf,
    fitToBox
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
  let shaderSwapToken = 0;
  let gamepadSource: GamepadSource = 'auto';

  let turbo = false;
  let showPauseMenu = false;
  let pauseRestoresFullscreen = false;
  let isFullscreen = false;
  let sramTimer: ReturnType<typeof setInterval> | null = null;
  let container: HTMLDivElement;

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

  const gamepadKey = 'psnes-gamepad-source';

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
  $: if (collector && keyConfig) collector.setKeyConfig(keyConfig);

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

    // Remembered the same way the home page's settings modal remembers it.
    if (next.shader) localStorage.setItem('psnes-shader', next.shader);
    else localStorage.removeItem('psnes-shader');
    await applyShader(next.shader);
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
            const binary = atob(data.sramData);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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
      const binary = atob(payload.saveData);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      core.loadState(bytes);
      // Otherwise audio buffered before the jump plays over the restored
      // state.
      audio?.flush();
      logger.info('Loaded save', { name: payload.name });
    } catch (err) {
      logger.error('Could not decode the save', err);
    }
  }

  function persistSram(): void {
    if (!sramLoaded) return;
    if (!core || !$socket) return;
    const sram = core.sram();
    if (sram.length === 0) return;
    let binary = '';
    for (let i = 0; i < sram.length; i++) binary += String.fromCharCode(sram[i]);
    $socket.emit('game:saveSram', { roomId, sramData: btoa(binary) });
  }

  async function boot() {
    try {
      setLogLabels({ roomId, player: 'solo' });

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
      if (destroyed) {
        teardown();
        return;
      }
      // Ask, do not assume: a room is reached by clicking, so the context
      // is usually already running and no gesture is needed.
      needsAudioGesture = audio.needsGesture;

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

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await container?.requestFullscreen();
    } catch (err) {
      logger.error('Could not toggle fullscreen', err);
    }
  }

  function onFullscreenChange(): void {
    isFullscreen = document.fullscreenElement !== null;
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
    collector?.detach();
    // Matches P2PRoom's auto-save on pause: a player who opens the menu is
    // often about to save or leave, and membership is still live here.
    persistSram();
  }

  function closePauseMenu(): void {
    showPauseMenu = false;
    // Input first: the first frame after resuming reads a live pad, not a
    // stale zero left over from before the clock restarts.
    collector?.attach();
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
    governor?.setTurbo(turbo);
    audio?.setMuted(turbo);
  }

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
    if (event.key !== 'Escape' || showPauseMenu) return;
    event.preventDefault();
    openPauseMenu(!!document.fullscreenElement);
  }

  /** Leaving the room: told to the server the same way LockstepRoom does it. */
  function quitToLobby(): void {
    // Before game:stop, mirroring P2PRoom's handleQuit: the parent page emits
    // room:leave in its own onDestroy, which runs before this component's
    // onDestroy (Svelte destroys a parent's on_destroy callbacks before its
    // children's). The server gates game:saveSram on room membership, so a
    // save that arrives after room:leave is silently dropped. Saving here,
    // while we are still a member, is what actually reaches the server.
    persistSram();
    // Reset first, not read back from document.fullscreenElement inside
    // closePauseMenu() after exitFullscreen() - that promise resolves
    // asynchronously, so relying on its timing would be fragile.
    pauseRestoresFullscreen = false;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    closePauseMenu();
    $socket?.emit('game:stop', { roomId });
  }

  function teardown() {
    destroyed = true;
    if (sramTimer) clearInterval(sramTimer);
    sramTimer = null;
    // Best-effort only, and usually a no-op: by the time onDestroy runs here,
    // the parent room page has already emitted room:leave from its own
    // onDestroy (a parent's on_destroy callbacks run before its children's),
    // so the server no longer counts us as a room member and rejects the
    // save. The real saves are the ones in quitToLobby() and
    // openPauseMenu(), which run while membership is still live. This one
    // only helps on a path that quits without going through either - e.g. a
    // parent-initiated teardown - and only if the drop happens to lag behind.
    persistSram();
    $socket?.off('game:loaded', onGameLoaded);
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
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    window.removeEventListener('keydown', onKeyDown);
  }

  onMount(() => {
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.addEventListener('keydown', onKeyDown);
    void boot();
  });

  onDestroy(() => {
    teardown();
  });
</script>

<div class="solo" class:paused={showPauseMenu} bind:this={container}>
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
  {#if romPrompt}
    <LocateRom checksum={gameCrc32 ?? ''} title={gameTitle} on:found={(e) => romPrompt?.(e.detail)} />
  {/if}

  {#if showPauseMenu}
    <PauseMenu
      {roomId}
      {gameId}
      {keyConfig}
      {display}
      scanlinesAvailable={!usingGl}
      {turbo}
      emulator={saveAdapter}
      on:resume={closePauseMenu}
      on:quit={quitToLobby}
      on:display={(e) => void onDisplayChange(e.detail)}
      on:turbo={toggleTurbo}
      on:saved={(e) => { keyConfig = e.detail.config; closePauseMenu(); }}
    />
  {/if}
</div>

<style>
  .solo {
    display: flex;
    flex-direction: column;
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
