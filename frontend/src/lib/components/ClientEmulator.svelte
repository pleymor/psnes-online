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
  let gamepadPollInterval: number | null = null;
  let lastGamepadState: Record<string, boolean> = {};

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

      // Install virtual gamepads for BOTH players BEFORE creating emulator
      const { VirtualGamepad, installVirtualGamepad } = await import('$lib/nostalgist-local/src/libs/virtual-gamepad.ts');

      // Player 1 (local/host) at gamepad index 0
      const virtualGamepadP1 = new VirtualGamepad(0);
      const cleanupP1 = installVirtualGamepad(virtualGamepadP1);
      console.log('🎮 Virtual gamepad for Player 1 installed at index 0');

      // Player 2 (remote/guest) at gamepad index 1
      const virtualGamepadP2 = new VirtualGamepad(1);
      const cleanupP2 = installVirtualGamepad(virtualGamepadP2);
      console.log('🎮 Virtual gamepad for Player 2 installed at index 1');

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
          input_max_users: '2',

          // Enable both player ports as joypads
          input_libretro_device_p1: '1', // RETRO_DEVICE_JOYPAD
          input_libretro_device_p2: '1', // RETRO_DEVICE_JOYPAD

          // Map players to their virtual gamepad indices
          input_player1_joypad_index: '0', // Player 1 uses gamepad at index 0
          input_player2_joypad_index: '1', // Player 2 uses gamepad at index 1
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

    // Translate keyboard input to virtual gamepad for Player 1
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();

        const nostalgistButton = keyMapping[button as keyof KeyConfig];
        const virtualGamepadP1 = (window as any).__virtualGamepadP1;

        if (virtualGamepadP1 && nostalgistButton) {
          virtualGamepadP1.pressButton(nostalgistButton);
          virtualGamepadP1.updateTimestamp();
          console.log(`🎮 P1 ${nostalgistButton}: pressed`);
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
          console.log(`🎮 P1 ${nostalgistButton}: released`);
        }
        break;
      }
    }
  }

  function pollGamepad() {
    if (!isHost || !emulator) return;

    const gamepads = navigator.getGamepads();
    let physicalGamepadIndex = 0; // Remap physical gamepads to start from index 0

    for (let i = 0; i < gamepads.length; i++) {
      const gamepad = gamepads[i];
      if (!gamepad) continue;

      // Skip virtual gamepads - only poll real physical controllers
      if (gamepad.id.includes('Virtual Gamepad')) {
        continue;
      }

      // Use remapped index for config matching (physical gamepads start from 0)
      const configIndex = physicalGamepadIndex;
      physicalGamepadIndex++;

      console.log(`🎮 P1 polling physical gamepad at real index ${i}, config index ${configIndex}: ${gamepad.id}`);

      // Check buttons
      for (let j = 0; j < gamepad.buttons.length; j++) {
        const inputCode = `Gamepad${configIndex}Button${j}`; // Use config index, not real index
        const isPressed = gamepad.buttons[j].pressed;
        const wasPressed = lastGamepadState[inputCode] || false;

        if (isPressed !== wasPressed) {
          lastGamepadState[inputCode] = isPressed;
          console.log('🎮 P1 gamepad button state change:', inputCode, 'pressed:', isPressed);

          // Find which button this input is mapped to
          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCode) {
              const nostalgistButton = keyMapping[button as keyof KeyConfig];
              const virtualGamepadP1 = (window as any).__virtualGamepadP1;

              if (virtualGamepadP1 && nostalgistButton) {
                if (isPressed) {
                  virtualGamepadP1.pressButton(nostalgistButton);
                } else {
                  virtualGamepadP1.releaseButton(nostalgistButton);
                }
                virtualGamepadP1.updateTimestamp();
                console.log(`🎮 P1 ${nostalgistButton}: ${isPressed ? 'pressed' : 'released'} via gamepad`);
              }
              break;
            }
          }
        }
      }

      // Check axes (for d-pad on some controllers)
      for (let j = 0; j < gamepad.axes.length; j++) {
        const axisValue = gamepad.axes[j];

        // Check positive direction
        const inputCodePlus = `Gamepad${configIndex}Axis${j}Plus`; // Use config index
        const isPressedPlus = axisValue > 0.5;
        const wasPressedPlus = lastGamepadState[inputCodePlus] || false;

        if (isPressedPlus !== wasPressedPlus) {
          lastGamepadState[inputCodePlus] = isPressedPlus;

          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCodePlus) {
              const nostalgistButton = keyMapping[button as keyof KeyConfig];
              const virtualGamepadP1 = (window as any).__virtualGamepadP1;

              if (virtualGamepadP1 && nostalgistButton) {
                if (isPressedPlus) {
                  virtualGamepadP1.pressButton(nostalgistButton);
                } else {
                  virtualGamepadP1.releaseButton(nostalgistButton);
                }
                virtualGamepadP1.updateTimestamp();
                console.log(`🎮 P1 ${nostalgistButton}: ${isPressedPlus ? 'pressed' : 'released'} via gamepad axis`);
              }
              break;
            }
          }
        }

        // Check negative direction
        const inputCodeMinus = `Gamepad${configIndex}Axis${j}Minus`; // Use config index
        const isPressedMinus = axisValue < -0.5;
        const wasPressedMinus = lastGamepadState[inputCodeMinus] || false;

        if (isPressedMinus !== wasPressedMinus) {
          lastGamepadState[inputCodeMinus] = isPressedMinus;

          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCodeMinus) {
              const nostalgistButton = keyMapping[button as keyof KeyConfig];
              const virtualGamepadP1 = (window as any).__virtualGamepadP1;

              if (virtualGamepadP1 && nostalgistButton) {
                if (isPressedMinus) {
                  virtualGamepadP1.pressButton(nostalgistButton);
                } else {
                  virtualGamepadP1.releaseButton(nostalgistButton);
                }
                virtualGamepadP1.updateTimestamp();
                console.log(`🎮 P1 ${nostalgistButton}: ${isPressedMinus ? 'pressed' : 'released'} via gamepad axis`);
              }
              break;
            }
          }
        }
      }
    }
  }

  function startGamepadPolling() {
    if (gamepadPollInterval !== null) return;
    console.log('🎮 P1 starting gamepad polling');
    gamepadPollInterval = window.setInterval(pollGamepad, 16); // Poll at ~60Hz
  }

  function stopGamepadPolling() {
    if (gamepadPollInterval !== null) {
      console.log('🎮 P1 stopping gamepad polling');
      clearInterval(gamepadPollInterval);
      gamepadPollInterval = null;
      lastGamepadState = {};
    }
  }

  export function handleRemoteInput(button: string, pressed: boolean) {
    if (!isHost) return;

    const nostalgistButton = keyMapping[button as keyof KeyConfig];
    console.log(`🎮 P2 ${nostalgistButton}: ${pressed}`);

    // Use the pre-installed virtual gamepad directly
    const virtualGamepad = (window as any).__virtualGamepadP2;
    if (virtualGamepad) {
      if (pressed) {
        virtualGamepad.pressButton(nostalgistButton);
      } else {
        virtualGamepad.releaseButton(nostalgistButton);
      }
      virtualGamepad.updateTimestamp();

      // Debug: Check gamepad state
      console.log('🎮 P2 Virtual Gamepad State:', {
        index: virtualGamepad.index,
        buttons: virtualGamepad.buttons.map((b: any, i: number) => b.pressed ? i : null).filter((x: any) => x !== null),
        axes: virtualGamepad.axes
      });

      // Debug: Check if navigator.getGamepads() sees it
      const gamepads = navigator.getGamepads();
      console.log('🎮 Navigator gamepads:', Array.from(gamepads).map((gp, i) => {
        if (gp) {
          const pressedButtons = Array.from(gp.buttons).map((b, idx) => b.pressed ? idx : null).filter(x => x !== null);
          return `${i}: ${gp.id} (pressed: [${pressedButtons}])`;
        }
        return `${i}: null`;
      }));

      // Also check gamepad at index 1 specifically
      const gp1 = gamepads[1];
      if (gp1) {
        console.log('🎮 Gamepad[1] detailed state:', {
          id: gp1.id,
          index: gp1.index,
          connected: gp1.connected,
          buttons: Array.from(gp1.buttons).map((b, i) => b.pressed ? `${i}:pressed` : null).filter(x => x),
          timestamp: gp1.timestamp
        });
      }
    } else {
      console.error('❌ Virtual gamepad not found on window');
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
      startGamepadPolling();
    }
  });

  onDestroy(() => {
    stopGamepadPolling();

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
