<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { Nostalgist } from 'nostalgist';
  import type { KeyConfig } from '$lib/types';

  export let romData: ArrayBuffer;
  export let keyConfig: KeyConfig;
  export let isHost: boolean = true; // true = host (runs emulator), false = guest (receives stream)

  const dispatch = createEventDispatcher();

  let canvas: HTMLCanvasElement;
  let emulator: any = null;
  let running = false;

  // Key mapping from KeyConfig to Nostalgist format
  const keyMapping: Record<keyof KeyConfig, string> = {
    up: 'up',
    down: 'down',
    left: 'left',
    right: 'right',
    a: 'a',
    b: 'b',
    x: 'x',
    y: 'y',
    l: 'l',
    r: 'r',
    start: 'start',
    select: 'select'
  };

  async function initEmulator() {
    if (!isHost) {
      console.log('Guest mode - waiting for stream');
      return;
    }

    try {
      console.log('🎮 Initializing client-side SNES emulator...');

      // Create emulator instance
      emulator = await Nostalgist.snes({
        element: canvas,
        rom: new Uint8Array(romData),
        style: {
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated'
        }
      });

      running = true;
      console.log('✅ Emulator initialized successfully');

      dispatch('ready', { emulator });

    } catch (error) {
      console.error('Failed to initialize emulator:', error);
      dispatch('error', { message: 'Failed to initialize emulator' });
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!isHost || !emulator) return;

    // Find which button corresponds to this key
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();
        const nostalgistButton = keyMapping[button as keyof KeyConfig];
        emulator.press(nostalgistButton);

        // Emit input for P2P transmission
        dispatch('input', { button, pressed: true });
        break;
      }
    }
  }

  function handleKeyUp(e: KeyboardEvent) {
    if (!isHost || !emulator) return;

    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();
        const nostalgistButton = keyMapping[button as keyof KeyConfig];
        emulator.release(nostalgistButton);

        dispatch('input', { button, pressed: false });
        break;
      }
    }
  }

  export function handleRemoteInput(button: string, pressed: boolean) {
    if (!isHost || !emulator) return;

    const nostalgistButton = keyMapping[button as keyof KeyConfig];
    if (pressed) {
      emulator.press(nostalgistButton);
    } else {
      emulator.release(nostalgistButton);
    }
  }

  export function pause() {
    if (emulator) {
      emulator.pause();
      running = false;
    }
  }

  export function resume() {
    if (emulator) {
      emulator.resume();
      running = true;
    }
  }

  export async function saveState(): Promise<Uint8Array | null> {
    if (!emulator) return null;
    try {
      return await emulator.saveState();
    } catch (error) {
      console.error('Failed to save state:', error);
      return null;
    }
  }

  export async function loadState(state: Uint8Array) {
    if (!emulator) return;
    try {
      await emulator.loadState(state);
    } catch (error) {
      console.error('Failed to load state:', error);
    }
  }

  export function getCanvas(): HTMLCanvasElement {
    return canvas;
  }

  onMount(() => {
    if (isHost) {
      initEmulator();
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
    }
  });

  onDestroy(() => {
    if (emulator) {
      emulator.exit();
    }
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
  });
</script>

<div class="emulator-container">
  {#if isHost}
    <canvas bind:this={canvas} />
  {:else}
    <div class="guest-message">
      <p>Waiting for host stream...</p>
    </div>
  {/if}
</div>

<style>
  .emulator-container {
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #000;
  }

  canvas {
    max-width: 100%;
    max-height: 100%;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  }

  .guest-message {
    color: #aaa;
    text-align: center;
  }
</style>
