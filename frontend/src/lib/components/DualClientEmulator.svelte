<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { WasmEmulator } from '$lib/emulator';
  import type { KeyConfig, InputState } from '$lib/types';
  import { EmulationMode } from '$lib/types';
  import { createLogger } from '$lib/utils/logger';
  import { DualEmulatorManager } from '$lib/netplay/dual-emulator-manager';

  const logger = createLogger('DualClientEmulator');

  export let romData: ArrayBuffer;
  export let keyConfig: KeyConfig;
  export let playerPort: 1 | 2 | null = 1;
  export let isHost: boolean = true;
  export let startPaused: boolean = false;
  export let initialState: Blob | null = null;

  // Local input state for synced mode
  let localInputState: InputState = {
    a: false, b: false, x: false, y: false,
    l: false, r: false, start: false, select: false,
    up: false, down: false, left: false, right: false
  };

  const dispatch = createEventDispatcher();

  let emulatorContainer: HTMLDivElement;
  let canvas0: HTMLCanvasElement;
  let canvas1: HTMLCanvasElement;
  let dualManager: DualEmulatorManager | null = null;
  let running = false;
  let gamepadPollInterval: number | null = null;
  let lastGamepadState: Record<string, boolean> = {};
  let originalGetGamepads: typeof navigator.getGamepads | null = null;
  let isFullscreen = false;

  // Key mapping
  const keyMapping: Record<keyof KeyConfig, string> = {
    up: 'up', down: 'down', left: 'left', right: 'right',
    a: 'a', b: 'b', x: 'x', y: 'y',
    l: 'l', r: 'r', start: 'start', select: 'select'
  };

  async function initDualEmulators() {
    logger.info(`Initializing DUAL emulators (${isHost ? 'HOST' : 'GUEST'})`);

    try {
      // Install virtual gamepads
      const { VirtualGamepad, installVirtualGamepad, getOriginalGetGamepads } = await import('$lib/emulator/libs/virtual-gamepad');

      const virtualGamepadP1 = new VirtualGamepad(0);
      const cleanupP1 = installVirtualGamepad(virtualGamepadP1);
      const virtualGamepadP2 = new VirtualGamepad(1);
      const cleanupP2 = installVirtualGamepad(virtualGamepadP2);

      (window as any).__virtualGamepadP1 = virtualGamepadP1;
      (window as any).__virtualGamepadP2 = virtualGamepadP2;
      (window as any).__cleanupVirtualGamepadP1 = cleanupP1;
      (window as any).__cleanupVirtualGamepadP2 = cleanupP2;

      originalGetGamepads = getOriginalGetGamepads();
      (window as any).__originalGetGamepads = originalGetGamepads;

      // Common emulator options
      const baseOptions: any = {
        rom: new Uint8Array(romData),
        style: {
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated'
        },
        runEmulatorManually: true,
        retroarchConfig: {
          input_max_users: 2,
          video_vsync: 'false',
          video_max_swapchain_images: '2',
          video_hard_sync: 'false',
          video_frame_delay: '0',
          video_threaded: 'false',
          audio_sync: 'true',
          audio_latency: '64',
          audio_max_timing_skew: '0.05',
          fastforward_ratio: '0.0',
          slowmotion_ratio: '1.0',
          run_ahead_enabled: 'false',
          input_libretro_device_p1: '1',
          input_libretro_device_p2: '1',
          input_player1_joypad_index: '0',
          input_player2_joypad_index: '1',
          // Disable keyboard bindings
          input_player1_a: 'nul', input_player1_b: 'nul', input_player1_x: 'nul', input_player1_y: 'nul',
          input_player1_l: 'nul', input_player1_r: 'nul', input_player1_l2: 'nul', input_player1_r2: 'nul',
          input_player1_l3: 'nul', input_player1_r3: 'nul', input_player1_start: 'nul', input_player1_select: 'nul',
          input_player1_up: 'nul', input_player1_down: 'nul', input_player1_left: 'nul', input_player1_right: 'nul',
          input_player2_a: 'nul', input_player2_b: 'nul', input_player2_x: 'nul', input_player2_y: 'nul',
          input_player2_l: 'nul', input_player2_r: 'nul', input_player2_l2: 'nul', input_player2_r2: 'nul',
          input_player2_l3: 'nul', input_player2_r3: 'nul', input_player2_start: 'nul', input_player2_select: 'nul',
          input_player2_up: 'nul', input_player2_down: 'nul', input_player2_left: 'nul', input_player2_right: 'nul',
        }
      };

      // Create first emulator (active)
      logger.info('Creating emulator [A] (active)...');
      const emulator0 = await WasmEmulator.snes({
        ...baseOptions,
        element: canvas0,
      });
      await emulator0.start();
      logger.info('Emulator [A] started');

      // Create second emulator (background)
      logger.info('Creating emulator [B] (background)...');
      const emulator1 = await WasmEmulator.snes({
        ...baseOptions,
        element: canvas1,
      });
      await emulator1.start();
      logger.info('Emulator [B] started');

      // Initialize the dual manager
      dualManager = new DualEmulatorManager({
        onReady: () => {
          logger.info('DualEmulatorManager ready');
        },
        onSwap: (newIndex) => {
          logger.info(`Swapped to emulator ${newIndex}`);
        },
        onError: (error) => {
          logger.error('DualEmulatorManager error:', error);
        }
      });

      dualManager.initialize(emulator0, canvas0, emulator1, canvas1);

      // If startPaused, pause both
      if (startPaused) {
        dualManager.pauseAll();
        running = false;
        logger.info('Both emulators started in paused state');
      } else {
        running = true;
      }

      // Load initial state if provided (for guest)
      if (initialState && dualManager) {
        logger.info(`Loading initial state into active emulator (${initialState.size} bytes)`);
        const activeEmulator = dualManager.getActiveEmulator();
        if (activeEmulator) {
          await activeEmulator.loadState(initialState);
        }
      }

      dispatch('ready', { dualManager });

    } catch (error) {
      logger.error('Failed to initialize dual emulators:', error);
      dispatch('error', { message: 'Failed to initialize emulators' });
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.altKey && e.key === 'Enter') {
      e.preventDefault();
      toggleFullscreen();
      return;
    }

    if (!dualManager) return;

    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        localInputState[button as keyof InputState] = true;
        break;
      }
    }
  }

  function handleKeyUp(e: KeyboardEvent) {
    if (!dualManager) return;

    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        localInputState[button as keyof InputState] = false;
        break;
      }
    }
  }

  function pollGamepad() {
    if (!dualManager || !originalGetGamepads) return;
    if (!document.hasFocus()) return;

    const gamepads = originalGetGamepads();
    let physicalGamepadIndex = 0;

    for (let i = 0; i < gamepads.length; i++) {
      const gamepad = gamepads[i];
      if (!gamepad) continue;
      if (gamepad.id.includes('Virtual Gamepad')) continue;

      const configIndex = physicalGamepadIndex;
      physicalGamepadIndex++;

      // Buttons
      for (let j = 0; j < gamepad.buttons.length; j++) {
        const inputCode = `Gamepad${configIndex}Button${j}`;
        const isPressed = gamepad.buttons[j].pressed;
        const wasPressed = lastGamepadState[inputCode] || false;

        if (isPressed !== wasPressed) {
          lastGamepadState[inputCode] = isPressed;
          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCode) {
              localInputState[button as keyof InputState] = isPressed;
              break;
            }
          }
        }
      }

      // Axes
      for (let j = 0; j < gamepad.axes.length; j++) {
        const axisValue = gamepad.axes[j];

        const inputCodePlus = `Gamepad${configIndex}Axis${j}Plus`;
        const isPressedPlus = axisValue > 0.5;
        const wasPressedPlus = lastGamepadState[inputCodePlus] || false;

        if (isPressedPlus !== wasPressedPlus) {
          lastGamepadState[inputCodePlus] = isPressedPlus;
          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCodePlus) {
              localInputState[button as keyof InputState] = isPressedPlus;
              break;
            }
          }
        }

        const inputCodeMinus = `Gamepad${configIndex}Axis${j}Minus`;
        const isPressedMinus = axisValue < -0.5;
        const wasPressedMinus = lastGamepadState[inputCodeMinus] || false;

        if (isPressedMinus !== wasPressedMinus) {
          lastGamepadState[inputCodeMinus] = isPressedMinus;
          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCodeMinus) {
              localInputState[button as keyof InputState] = isPressedMinus;
              break;
            }
          }
        }
      }
    }
  }

  function startGamepadPolling() {
    if (gamepadPollInterval !== null) return;
    gamepadPollInterval = window.setInterval(pollGamepad, 16);
  }

  function stopGamepadPolling() {
    if (gamepadPollInterval !== null) {
      clearInterval(gamepadPollInterval);
      gamepadPollInterval = null;
      lastGamepadState = {};
    }
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        await emulatorContainer.requestFullscreen();
        isFullscreen = true;
      } else {
        await document.exitFullscreen();
        isFullscreen = false;
      }
    } catch (error) {
      logger.error('Error toggling fullscreen:', error);
    }
  }

  // Exposed methods

  export function getDualManager(): DualEmulatorManager | null {
    return dualManager;
  }

  export function getEmulator(): WasmEmulator | null {
    return dualManager?.getActiveEmulator() ?? null;
  }

  export function getCurrentInputState(): InputState {
    return { ...localInputState };
  }

  export function applyInput(port: 1 | 2, input: InputState) {
    // Apply to the active emulator's virtual gamepad
    const virtualGamepad = port === 1
      ? (window as any).__virtualGamepadP1
      : (window as any).__virtualGamepadP2;

    if (!virtualGamepad) return;

    const buttons: (keyof InputState)[] = ['a', 'b', 'x', 'y', 'l', 'r', 'start', 'select', 'up', 'down', 'left', 'right'];

    for (const button of buttons) {
      const mappedButton = keyMapping[button];
      const pressed = input[button];
      if (pressed) {
        virtualGamepad.pressButton(mappedButton);
      } else {
        virtualGamepad.releaseButton(mappedButton);
      }
    }
    virtualGamepad.updateTimestamp();
  }

  export function pause() {
    if (dualManager) {
      dualManager.pauseAll();
      running = false;
    }
  }

  export function resume() {
    if (dualManager) {
      dualManager.resumeAll();
      running = true;
    }
  }

  export async function loadStateAndSwap(stateBlob: Blob): Promise<void> {
    if (dualManager) {
      await dualManager.loadStateAndSwap(stateBlob);
    }
  }

  export function getCanvas(): HTMLCanvasElement | null {
    return dualManager?.getActiveCanvas() ?? canvas0;
  }

  onMount(() => {
    initDualEmulators();
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    startGamepadPolling();
  });

  onDestroy(() => {
    stopGamepadPolling();

    if (dualManager) {
      dualManager.destroy();
    }

    const cleanupP1 = (window as any).__cleanupVirtualGamepadP1;
    const cleanupP2 = (window as any).__cleanupVirtualGamepadP2;
    if (cleanupP1) cleanupP1();
    if (cleanupP2) cleanupP2();

    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
  });
</script>

<div class="dual-emulator-container" bind:this={emulatorContainer}>
  <div class="canvas-wrapper">
    <canvas bind:this={canvas0} class="emulator-canvas active" />
    <canvas bind:this={canvas1} class="emulator-canvas background" />
  </div>
</div>

<style>
  .dual-emulator-container {
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #000;
    overflow: hidden;
    position: relative;
  }

  .canvas-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  /* Both canvases stack on top of each other */
  .emulator-canvas {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  }

  /* Initial state - first canvas visible, second hidden */
  .emulator-canvas.active {
    opacity: 1;
    z-index: 2;
    pointer-events: auto;
  }

  .emulator-canvas.background {
    opacity: 0;
    z-index: 1;
    pointer-events: none;
  }

  .dual-emulator-container:fullscreen {
    background: #000;
    cursor: none;
  }

  .dual-emulator-container:fullscreen .emulator-canvas {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
</style>
