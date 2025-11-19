<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { Nostalgist } from 'nostalgist';
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

  const localPlayer = 0;  // Player 1 (0-indexed)
  const remotePlayer = 1; // Player 2 (0-indexed)

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
        // Enable 2-player support
        retroarchConfig: {
          input_max_users: 2,
          input_player1_joypad_index: localPlayer,
          input_player2_joypad_index: remotePlayer,
          
          // input_player1_up: 'ArrowUp',
          // input_player1_down: 'ArrowDown',
          // input_player1_left: 'ArrowLeft',
          // input_player1_right: 'ArrowRight',
          // input_player1_a: 'KeyX',
          // input_player1_b: 'KeyZ',
          // input_player1_x: 'KeyS',
          // input_player1_y: 'KeyA',
          // input_player1_l: 'KeyQ',
          // input_player1_r: 'KeyW',
          // input_player1_start: 'Enter',
          // input_player1_select: 'ShiftRight',

          // input_player2_up: 'ArrowUp',
          // input_player2_down: 'ArrowDown',
          // input_player2_left: 'ArrowLeft',
          // input_player2_right: 'ArrowRight',
          // input_player2_a: 'KeyX',
          // input_player2_b: 'KeyZ',
          // input_player2_x: 'KeyS',
          // input_player2_y: 'KeyA',
          // input_player2_l: 'KeyQ',
          // input_player2_r: 'KeyW',
          // input_player2_start: 'Enter',
          // input_player2_select: 'ShiftRight',
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
    console.log(`handleKeyDown called with code=${e.code}`);
    if (!isHost || !emulator) return;

    // Find which button corresponds to this key
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();
        const nostalgistButton = keyMapping[button as keyof KeyConfig];
        console.log(`🎮 Host input: player 1, button ${nostalgistButton}, pressed true`);
        // Player numbers are 0-indexed: 0 = player 1, 1 = player 2
        emulator.pressDown({ button: nostalgistButton, player: localPlayer });
        break;
      }
    }
  }

  function handleKeyUp(e: KeyboardEvent) {
    console.log(`handleKeyUp called with code=${e.code}`);
    if (!isHost || !emulator) return;

    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();
        const nostalgistButton = keyMapping[button as keyof KeyConfig];
        console.log(`🎮 Host input: player 1, button ${nostalgistButton}, pressed false`);
        // Player numbers are 0-indexed: 0 = player 1, 1 = player 2
        emulator.pressUp({ button: nostalgistButton, player: localPlayer });
        break;
      }
    }
  }

  export function handleRemoteInput(button: string, pressed: boolean) {
    console.log(`handleRemoteInput called with button=${button}, pressed=${pressed}`);
    if (!isHost || !emulator) return;

    const nostalgistButton = keyMapping[button as keyof KeyConfig];
    console.log(`🎮 Remote input: player 2, button ${nostalgistButton}, pressed ${pressed}`);

    // Use Nostalgist's pressDown/pressUp with object syntax
    // Player numbers are 0-indexed: 0 = player 1, 1 = player 2
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
