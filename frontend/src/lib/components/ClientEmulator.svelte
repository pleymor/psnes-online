<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { Nostalgist } from '$lib/nostalgist-local/src';
  import type { KeyConfig } from '$lib/types';

  export let romData: ArrayBuffer;
  export let keyConfig: KeyConfig;
  export let isHost: boolean = true; // true = host (runs emulator), false = guest (receives stream)

  const dispatch = createEventDispatcher();

  // Debug: Log keyConfig whenever it changes
  $: {
    console.log('🎮 ClientEmulator received keyConfig:', keyConfig);
  }

  let canvas: HTMLCanvasElement;
  let emulator: Nostalgist;
  let running = false;
  let gamepadPollInterval: number | null = null;
  let lastGamepadState: Record<string, boolean> = {};
  let originalGetGamepads: typeof navigator.getGamepads | null = null;

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

      // Capture original getGamepads BEFORE installing virtual gamepads
      // We'll use this to poll physical gamepads while hiding them from RetroArch
      originalGetGamepads = navigator.getGamepads.bind(navigator);

      // Store on window so ControlsSettings can also access it
      (window as any).__originalGetGamepads = originalGetGamepads;

      // Install virtual gamepads for BOTH players BEFORE creating emulator
      // Use indices 0 and 1 (standard player positions)
      // Physical gamepads will be hidden from RetroArch
      const { VirtualGamepad, installVirtualGamepad } = await import('$lib/nostalgist-local/src/libs/virtual-gamepad');

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
          input_max_users: 2,

          // Enable both player ports as joypads
          input_libretro_device_p1: '1', // RETRO_DEVICE_JOYPAD
          input_libretro_device_p2: '1', // RETRO_DEVICE_JOYPAD

          // Map players to their virtual gamepad indices (0 and 1)
          input_player1_joypad_index: '0', // Player 1 uses gamepad at index 0
          input_player2_joypad_index: '1', // Player 2 uses gamepad at index 1

          // Disable ALL keyboard bindings - use "nul" to completely disable keyboard input
          // RetroArch will only respond to virtual gamepads
          input_player1_a: 'nul',
          input_player1_b: 'nul',
          input_player1_x: 'nul',
          input_player1_y: 'nul',
          input_player1_l: 'nul',
          input_player1_r: 'nul',
          input_player1_l2: 'nul',
          input_player1_r2: 'nul',
          input_player1_l3: 'nul',
          input_player1_r3: 'nul',
          input_player1_start: 'nul',
          input_player1_select: 'nul',
          input_player1_up: 'nul',
          input_player1_down: 'nul',
          input_player1_left: 'nul',
          input_player1_right: 'nul',

          input_player2_a: 'nul',
          input_player2_b: 'nul',
          input_player2_x: 'nul',
          input_player2_y: 'nul',
          input_player2_l: 'nul',
          input_player2_r: 'nul',
          input_player2_l2: 'nul',
          input_player2_r2: 'nul',
          input_player2_l3: 'nul',
          input_player2_r3: 'nul',
          input_player2_start: 'nul',
          input_player2_select: 'nul',
          input_player2_up: 'nul',
          input_player2_down: 'nul',
          input_player2_left: 'nul',
          input_player2_right: 'nul',
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

          // Debug: Check if navigator.getGamepads() sees the change
          const gamepads = navigator.getGamepads();
          const gp0 = gamepads[0];
          if (gp0) {
            console.log('🎮 Gamepad[0] after press:', {
              id: gp0.id,
              buttons: Array.from(gp0.buttons).map((b, i) => b.pressed ? i : null).filter(x => x !== null),
              timestamp: gp0.timestamp
            });
          } else {
            console.log('❌ Gamepad[0] not found in navigator.getGamepads()!');
          }
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
    if (!isHost || !emulator || !originalGetGamepads) return;

    // Use original getGamepads to see physical controllers
    // (navigator.getGamepads is overridden to hide them from RetroArch)
    const gamepads = originalGetGamepads();
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

      // Check buttons
      for (let j = 0; j < gamepad.buttons.length; j++) {
        const inputCode = `Gamepad${configIndex}Button${j}`; // Use config index, not real index
        const isPressed = gamepad.buttons[j].pressed;
        const wasPressed = lastGamepadState[inputCode] || false;

        if (isPressed !== wasPressed) {
          lastGamepadState[inputCode] = isPressed;
          console.log('🎮 P1 gamepad button state change:', inputCode, 'pressed:', isPressed);
          console.log('🎮 P1 checking against keyConfig:', keyConfig);

          // Find which button this input is mapped to
          let found = false;
          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCode) {
              found = true;
              console.log(`🎮 P1 Found mapping: ${button} -> ${mappedInput}`);
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
          if (!found) {
            console.log(`🎮 P1 No mapping found for ${inputCode}`);
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
          console.log('🎮 P1 gamepad axis state change:', inputCodePlus, 'value:', axisValue.toFixed(2), 'pressed:', isPressedPlus);

          let foundPlus = false;
          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCodePlus) {
              foundPlus = true;
              console.log(`🎮 P1 Found axis mapping: ${button} -> ${mappedInput}`);
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
          if (!foundPlus) {
            console.log(`🎮 P1 No mapping found for ${inputCodePlus}`);
          }
        }

        // Check negative direction
        const inputCodeMinus = `Gamepad${configIndex}Axis${j}Minus`; // Use config index
        const isPressedMinus = axisValue < -0.5;
        const wasPressedMinus = lastGamepadState[inputCodeMinus] || false;

        if (isPressedMinus !== wasPressedMinus) {
          lastGamepadState[inputCodeMinus] = isPressedMinus;
          console.log('🎮 P1 gamepad axis state change:', inputCodeMinus, 'value:', axisValue.toFixed(2), 'pressed:', isPressedMinus);

          let foundMinus = false;
          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCodeMinus) {
              foundMinus = true;
              console.log(`🎮 P1 Found axis mapping: ${button} -> ${mappedInput}`);
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
          if (!foundMinus) {
            console.log(`🎮 P1 No mapping found for ${inputCodeMinus}`);
          }
        }
      }
    }
  }

  function handleGamepadConnected(e: GamepadEvent) {
    console.log('🎮 P1 Physical gamepad connected!', e.gamepad.id, 'at index', e.gamepad.index);

    // Log the full gamepad array to see actual positions (use original to see physical gamepads)
    if (originalGetGamepads) {
      const gamepads = originalGetGamepads();
      console.log('🎮 P1 Full gamepad array after connection (original):', Array.from(gamepads).map((gp, i) =>
        gp ? `[${i}] ${gp.id}` : `[${i}] null`
      ));
    }
  }

  function handleGamepadDisconnected(e: GamepadEvent) {
    console.log('🎮 P1 Physical gamepad disconnected!', e.gamepad.id, 'at index', e.gamepad.index);
  }

  function startGamepadPolling() {
    if (gamepadPollInterval !== null) return;
    console.log('🎮 P1 starting gamepad polling');

    // Listen for gamepad connection events
    window.addEventListener('gamepadconnected', handleGamepadConnected);
    window.addEventListener('gamepaddisconnected', handleGamepadDisconnected);

    // Log currently connected gamepads (use original to see physical gamepads)
    if (originalGetGamepads) {
      const gamepads = originalGetGamepads();
      console.log('🎮 P1 Gamepads at polling start (original):', Array.from(gamepads).map((gp, i) =>
        gp ? `[${i}] ${gp.id}` : `[${i}] null`
      ));
    }

    gamepadPollInterval = window.setInterval(pollGamepad, 16); // Poll at ~60Hz
  }

  function stopGamepadPolling() {
    if (gamepadPollInterval !== null) {
      console.log('🎮 P1 stopping gamepad polling');
      clearInterval(gamepadPollInterval);
      gamepadPollInterval = null;
      lastGamepadState = {};

      // Remove event listeners
      window.removeEventListener('gamepadconnected', handleGamepadConnected);
      window.removeEventListener('gamepaddisconnected', handleGamepadDisconnected);
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
