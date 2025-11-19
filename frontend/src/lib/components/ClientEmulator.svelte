<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { Nostalgist } from '$lib/nostalgist-local/src';
  import type { KeyConfig } from '$lib/types';

  export let romData: ArrayBuffer;
  export let keyConfig: KeyConfig;
  export let isHost: boolean = true; // true = host (runs emulator), false = guest (receives stream)

  const dispatch = createEventDispatcher();

  let canvas: HTMLCanvasElement;
  let emulator: Nostalgist;
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

  const localPlayer = 1;  // Player 1 (1-indexed for API)
  const remotePlayer = 2; // Player 2 (1-indexed for API)

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
        },
        // Enable 2-player support with unique keybindings
        // Player 1 uses default keyboard, Player 2 uses numpad
        retroarchConfig: {
          input_max_users: 2,
          input_player1_joypad_index: 0, // RetroArch uses 0-indexed joypad
          input_player2_joypad_index: 1,

          // Player 2 mapped to numpad keys (matches getUniqueInputCode in emulator.ts)
          input_player2_up: 'num8',
          input_player2_down: 'num2',
          input_player2_left: 'num4',
          input_player2_right: 'num6',
          input_player2_a: 'num7',
          input_player2_b: 'num9',
          input_player2_x: 'num1',
          input_player2_y: 'num3',
          input_player2_l: 'subtract',
          input_player2_r: 'add',
          input_player2_start: 'kp_enter',
          input_player2_select: 'num0',
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
        emulator.pressDown({ button: nostalgistButton, player: localPlayer });
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
        emulator.pressUp({ button: nostalgistButton, player: localPlayer });
        break;
      }
    }
  }

  export function handleRemoteInput(button: string, pressed: boolean) {
    if (!isHost || !emulator) return;

    const nostalgistButton = keyMapping[button as keyof KeyConfig];

    // Remote player uses player 2 port
    if (pressed) {
      emulator.pressDown({ button: nostalgistButton, player: remotePlayer });
    } else {
      emulator.pressUp({ button: nostalgistButton, player: remotePlayer });
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
