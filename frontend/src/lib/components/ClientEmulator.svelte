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
      return;
    }

    try {
      // Install virtual gamepads for BOTH players BEFORE creating emulator
      const { VirtualGamepad, installVirtualGamepad } = await import('$lib/nostalgist-local/src/libs/virtual-gamepad.ts');

      // Player 1 (local/host) at gamepad index 0
      const virtualGamepadP1 = new VirtualGamepad(0);
      const cleanupP1 = installVirtualGamepad(virtualGamepadP1);

      // Player 2 (remote/guest) at gamepad index 1
      const virtualGamepadP2 = new VirtualGamepad(1);
      const cleanupP2 = installVirtualGamepad(virtualGamepadP2);

      // Store references for later use
      (window as any).__virtualGamepadP1 = virtualGamepadP1;
      (window as any).__virtualGamepadP2 = virtualGamepadP2;
      (window as any).__cleanupVirtualGamepadP1 = cleanupP1;
      (window as any).__cleanupVirtualGamepadP2 = cleanupP2;

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
        // Both players use virtual gamepads for native gamepad API support
        retroarchConfig: {
          input_max_users: 2,

          // Enable both player ports as joypads
          input_libretro_device_p1: 1, // RETRO_DEVICE_JOYPAD
          input_libretro_device_p2: 1, // RETRO_DEVICE_JOYPAD

          // Map players to their virtual gamepad indices
          input_player1_joypad_index: 0, // Player 1 uses gamepad at index 0
          input_player2_joypad_index: 1, // Player 2 uses gamepad at index 1
        }
      });

      dispatch('ready', { emulator });

    } catch (error) {
      console.error('Failed to initialize emulator:', error);
      dispatch('error', { message: 'Failed to initialize emulator' });
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (!isHost || !emulator) return;

    // Translate keyboard input to virtual gamepad for Player 1
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();

        const nostalgistButton = keyMapping[button as keyof KeyConfig];
        const virtualGamepadP1 = (window as any).__virtualGamepadP1;

        if (virtualGamepadP1 && nostalgistButton) {
          virtualGamepadP1.pressButton(nostalgistButton);
          virtualGamepadP1.updateTimestamp();
        }
        break;
      }
    }
  }

  function handleKeyUp(e: KeyboardEvent) {
    if (!isHost || !emulator) return;

    // Translate keyboard input to virtual gamepad for Player 1
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();

        const nostalgistButton = keyMapping[button as keyof KeyConfig];
        const virtualGamepadP1 = (window as any).__virtualGamepadP1;

        if (virtualGamepadP1 && nostalgistButton) {
          virtualGamepadP1.releaseButton(nostalgistButton);
          virtualGamepadP1.updateTimestamp();
        }
        break;
      }
    }
  }

  export function handleRemoteInput(button: string, pressed: boolean) {
    if (!isHost) return;

    const nostalgistButton = keyMapping[button as keyof KeyConfig];
    const virtualGamepad = (window as any).__virtualGamepadP2;

    if (virtualGamepad) {
      if (pressed) {
        virtualGamepad.pressButton(nostalgistButton);
      } else {
        virtualGamepad.releaseButton(nostalgistButton);
      }
      virtualGamepad.updateTimestamp();
    }
  }

  export function pause() {
    if (emulator) {
      emulator.pause();
    }
  }

  export function resume() {
    if (emulator) {
      emulator.resume();
    }
  }

  export async function saveState() {
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

    // Cleanup virtual gamepads
    const cleanupP1 = (window as any).__cleanupVirtualGamepadP1;
    const cleanupP2 = (window as any).__cleanupVirtualGamepadP2;
    if (cleanupP1) cleanupP1();
    if (cleanupP2) cleanupP2();

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
