<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { Nostalgist } from '$lib/emulator';
  import type { KeyConfig } from '$lib/types';

  export let romData: ArrayBuffer;
  export let keyConfig: KeyConfig;
  export let isHost: boolean = true; // true = host (runs emulator), false = guest (receives stream)

  const dispatch = createEventDispatcher();

  let canvas: HTMLCanvasElement;
  let emulatorContainer: HTMLDivElement;
  let emulator: Nostalgist;
  let running = false;
  let gamepadPollInterval: number | null = null;
  let lastGamepadState: Record<string, boolean> = {};
  let originalGetGamepads: typeof navigator.getGamepads | null = null;
  let isFullscreen = false;
  let currentSpeed: 'normal' | 'fast' | 'slow' = 'normal';
  let showSpeedIndicator = false;
  let speedIndicatorTimeout: ReturnType<typeof setTimeout> | null = null;

  // Latency metrics
  let inputLatency = 0;      // Time from keydown to input processing (ms)
  let totalLatency = 0;      // Time from keydown to frame render (ms)
  let lastInputTimestamp: number | null = null;
  let frameRenderTimestamp: number | null = null;
  let latencyHistoryInput: number[] = [];  // Rolling average
  let latencyHistoryTotal: number[] = [];  // Rolling average
  const LATENCY_HISTORY_SIZE = 10;

  // FPS monitoring
  let currentFPS = 0;
  let lastFrameTime = 0;
  let frameCount = 0;
  let fpsInterval: number | null = null;

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

  // Latency measurement functions
  function measureLatency() {
    if (lastInputTimestamp !== null) {
      // First requestAnimationFrame: measures time to next frame (input processing)
      requestAnimationFrame(() => {
        if (lastInputTimestamp !== null) {
          const now = performance.now();
          const inputLat = now - lastInputTimestamp;

          // Update input latency (time to first frame after input)
          latencyHistoryInput.push(inputLat);
          if (latencyHistoryInput.length > LATENCY_HISTORY_SIZE) {
            latencyHistoryInput.shift();
          }
          inputLatency = latencyHistoryInput.reduce((a, b) => a + b, 0) / latencyHistoryInput.length;

          // Second requestAnimationFrame: measures time to frame render (image display)
          const inputTime = lastInputTimestamp;
          requestAnimationFrame(() => {
            const now2 = performance.now();
            const totalLat = now2 - inputTime;

            latencyHistoryTotal.push(totalLat);
            if (latencyHistoryTotal.length > LATENCY_HISTORY_SIZE) {
              latencyHistoryTotal.shift();
            }
            totalLatency = latencyHistoryTotal.reduce((a, b) => a + b, 0) / latencyHistoryTotal.length;
          });

          lastInputTimestamp = null;
        }
      });
    }
  }


  async function initEmulator() {
    if (!isHost) {
      return;
    }

    try {
      // Capture original getGamepads BEFORE installing virtual gamepads
      // We'll use this to poll physical gamepads while hiding them from RetroArch
      originalGetGamepads = navigator.getGamepads.bind(navigator);

      // Store on window so ControlsSettings can also access it
      (window as any).__originalGetGamepads = originalGetGamepads;

      // Install virtual gamepads for BOTH players BEFORE creating emulator
      // Use indices 0 and 1 (standard player positions)
      // Physical gamepads will be hidden from RetroArch
      const { VirtualGamepad, installVirtualGamepad } = await import('$lib/emulator/libs/virtual-gamepad');

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
      // SNES native resolution: 256x224
      // Using 3x scale: 768x672 for optimal quality/performance balance
      emulator = await Nostalgist.snes({
        element: canvas,
        rom: new Uint8Array(romData),
        size: {
          width: 768,
          height: 672
        },
        style: {
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated'
        },
        // Enable 2-player support
        // Both players use virtual gamepads for native gamepad API support
        retroarchConfig: {
          input_max_users: 2,

          // Performance optimizations for 60 FPS
          video_vsync: 'false',             // Disable VSync to allow manual FPS control
          video_max_swapchain_images: '2',  // Double buffering
          video_hard_sync: 'false',         // Disable hard GPU sync for better performance
          video_frame_delay: '0',           // No artificial frame delay
          video_threaded: 'false',          // Disable threaded video for more predictable timing
          audio_sync: 'true',               // Keep audio in sync (this limits to 60 FPS)
          audio_latency: '64',              // Low audio latency (64ms)
          audio_max_timing_skew: '0.05',    // Sync video to audio (forces 60 FPS)
          fastforward_ratio: '1.0',         // Set to 1.0 = exactly 60 FPS (no fast-forward)
          slowmotion_ratio: '1.0',          // Disable slow motion
          run_ahead_enabled: 'false',       // Disable run-ahead (can cause issues)

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
      dispatch('ready', { emulator });

    } catch (error) {
      console.error('Failed to initialize emulator:', error);
      dispatch('error', { message: 'Failed to initialize emulator' });
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Fullscreen toggle with Alt+Enter (works for both host and guest)
    if (e.altKey && e.key === 'Enter') {
      e.preventDefault();
      toggleFullscreen();
      return;
    }

    if (!isHost || !emulator) return;

    // Speed control
    if (e.key === 'Tab') {
      e.preventDefault();
      toggleSpeed();
      return;
    }

    // Translate keyboard input to virtual gamepad for Player 1 ONLY
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();

        // Capture timestamp for latency measurement
        lastInputTimestamp = performance.now();

        const nostalgistButton = keyMapping[button as keyof KeyConfig];
        const virtualGamepadP1 = (window as any).__virtualGamepadP1;

        // DEFENSIVE: Only update P1, never P2
        if (virtualGamepadP1 && nostalgistButton && virtualGamepadP1.index === 0) {
          virtualGamepadP1.pressButton(nostalgistButton);
          virtualGamepadP1.updateTimestamp();

          // Measure latency
          measureLatency();
        }
        break;
      }
    }
  }

  function handleKeyUp(e: KeyboardEvent) {
    if (!isHost || !emulator) return;

    // Translate keyboard input to virtual gamepad for Player 1 ONLY
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();

        const nostalgistButton = keyMapping[button as keyof KeyConfig];
        const virtualGamepadP1 = (window as any).__virtualGamepadP1;

        // DEFENSIVE: Only update P1, never P2
        if (virtualGamepadP1 && nostalgistButton && virtualGamepadP1.index === 0) {
          virtualGamepadP1.releaseButton(nostalgistButton);
          virtualGamepadP1.updateTimestamp();
        }
        break;
      }
    }
  }

  function pollGamepad() {
    if (!isHost || !emulator || !originalGetGamepads) return;

    // IMPORTANT: Only poll gamepad when THIS window has focus
    // This prevents both host and guest from polling the same physical gamepad
    if (!document.hasFocus()) {
      return;
    }

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

          // Find which button this input is mapped to
          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCode) {
              const nostalgistButton = keyMapping[button as keyof KeyConfig];
              const virtualGamepadP1 = (window as any).__virtualGamepadP1;

              // DEFENSIVE: Only update P1, never P2
              if (virtualGamepadP1 && nostalgistButton && virtualGamepadP1.index === 0) {
                if (isPressed) {
                  // Capture timestamp for latency measurement
                  lastInputTimestamp = performance.now();
                  virtualGamepadP1.pressButton(nostalgistButton);
                  measureLatency();
                } else {
                  virtualGamepadP1.releaseButton(nostalgistButton);
                }
                virtualGamepadP1.updateTimestamp();
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

              // DEFENSIVE: Only update P1, never P2
              if (virtualGamepadP1 && nostalgistButton && virtualGamepadP1.index === 0) {
                if (isPressedPlus) {
                  lastInputTimestamp = performance.now();
                  virtualGamepadP1.pressButton(nostalgistButton);
                  measureLatency();
                } else {
                  virtualGamepadP1.releaseButton(nostalgistButton);
                }
                virtualGamepadP1.updateTimestamp();
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

              // DEFENSIVE: Only update P1, never P2
              if (virtualGamepadP1 && nostalgistButton && virtualGamepadP1.index === 0) {
                if (isPressedMinus) {
                  lastInputTimestamp = performance.now();
                  virtualGamepadP1.pressButton(nostalgistButton);
                  measureLatency();
                } else {
                  virtualGamepadP1.releaseButton(nostalgistButton);
                }
                virtualGamepadP1.updateTimestamp();
              }
              break;
            }
          }
        }
      }
    }
  }

  function handleGamepadConnected(e: GamepadEvent) {
    // Physical gamepad connected
  }

  function handleGamepadDisconnected(e: GamepadEvent) {
    // Physical gamepad disconnected
  }

  function startGamepadPolling() {
    if (gamepadPollInterval !== null) return;

    // Listen for gamepad connection events
    window.addEventListener('gamepadconnected', handleGamepadConnected);
    window.addEventListener('gamepaddisconnected', handleGamepadDisconnected);

    gamepadPollInterval = window.setInterval(pollGamepad, 16); // Poll at ~60Hz
  }

  function stopGamepadPolling() {
    if (gamepadPollInterval !== null) {
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
    const virtualGamepadP2 = (window as any).__virtualGamepadP2;

    // DEFENSIVE: Only update P2, never P1
    if (virtualGamepadP2 && virtualGamepadP2.index === 1) {
      if (pressed) {
        virtualGamepadP2.pressButton(nostalgistButton);
      } else {
        virtualGamepadP2.releaseButton(nostalgistButton);
      }
      virtualGamepadP2.updateTimestamp();
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

  export function resize(width: number, height: number) {
    if (emulator) {
      emulator.resize({ width, height });
    }
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        // Enter fullscreen
        await emulatorContainer.requestFullscreen();
        isFullscreen = true;
      } else {
        // Exit fullscreen
        await document.exitFullscreen();
        isFullscreen = false;
      }
    } catch (error) {
      console.error('Error toggling fullscreen:', error);
    }
  }

  function handleFullscreenChange() {
    isFullscreen = !!document.fullscreenElement;
  }

  function toggleSpeed() {
    // Toggle between normal and fast
    const newSpeed = currentSpeed === 'normal' ? 'fast' : 'normal';
    setSpeed(newSpeed);
  }

  function setSpeed(speed: 'normal' | 'fast' | 'slow') {
    if (!emulator || currentSpeed === speed) return;

    // Turn off current speed mode
    if (currentSpeed === 'fast') {
      emulator.sendCommand('FAST_FORWARD'); // Toggle off fast forward
    } else if (currentSpeed === 'slow') {
      emulator.sendCommand('SLOWMOTION'); // Toggle off slow motion
    }

    // Turn on new speed mode
    if (speed === 'fast') {
      emulator.sendCommand('FAST_FORWARD'); // Toggle on fast forward
    } else if (speed === 'slow') {
      emulator.sendCommand('SLOWMOTION'); // Toggle on slow motion
    }

    currentSpeed = speed;
    showSpeedIndicatorBriefly();
  }

  function showSpeedIndicatorBriefly() {
    showSpeedIndicator = true;
    if (speedIndicatorTimeout) clearTimeout(speedIndicatorTimeout);
    speedIndicatorTimeout = setTimeout(() => {
      showSpeedIndicator = false;
    }, 2000);
  }

  function startFPSMonitoring() {
    lastFrameTime = performance.now();
    frameCount = 0;
    let lastLogTime = performance.now();

    const measureFPS = () => {
      const now = performance.now();
      frameCount++;

      // Log FPS every 2 seconds (less spam)
      if (now - lastLogTime >= 2000) {
        currentFPS = Math.round((frameCount * 1000) / (now - lastLogTime));
        console.log(`📊 Emulator FPS: ${currentFPS}`);
        frameCount = 0;
        lastLogTime = now;
      }

      requestAnimationFrame(measureFPS);
    };

    requestAnimationFrame(measureFPS);
  }

  onMount(() => {
    if (isHost) {
      initEmulator();
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('keyup', handleKeyUp);
      // Re-enable gamepad polling for host, but only when window has focus
      startGamepadPolling();
      startFPSMonitoring();
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
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

    if (speedIndicatorTimeout) clearTimeout(speedIndicatorTimeout);

    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
  });
</script>

<div class="emulator-container" bind:this={emulatorContainer}>
  {#if isHost}
    <canvas bind:this={canvas} />

    <!-- Latency indicator (always visible) -->
    <div class="latency-indicator">
      <div class="latency-label">Latence</div>
      <div class="latency-row">
        <span class="latency-name">Input:</span>
        <span class="latency-value">{inputLatency.toFixed(1)}ms</span>
      </div>
      <div class="latency-row">
        <span class="latency-name">Input+Image:</span>
        <span class="latency-value">{totalLatency.toFixed(1)}ms</span>
      </div>
    </div>

    {#if showSpeedIndicator}
      <div class="speed-indicator" class:fast={currentSpeed === 'fast'} class:slow={currentSpeed === 'slow'}>
        <div class="speed-icon">⚡</div>
        <div class="speed-text">
          {#if currentSpeed === 'fast'}
            MAX
          {:else if currentSpeed === 'slow'}
            0.5x
          {:else}
            1x
          {/if}
        </div>
        <div class="speed-hint">
          Tab: Toggle
        </div>
      </div>
    {/if}
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

  .emulator-container:fullscreen {
    background: #000;
  }

  .emulator-container:fullscreen canvas {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  canvas {
    /* Maintain stable size and aspect ratio */
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 100%;

    /* SNES native aspect ratio */
    aspect-ratio: 256 / 224;

    /* Prevent resizing */
    object-fit: contain;

    image-rendering: pixelated;
    image-rendering: crisp-edges;

    /* Prevent layout shifts */
    display: block;
  }

  .guest-message {
    color: #aaa;
    text-align: center;
  }

  .latency-indicator {
    position: absolute;
    bottom: 20px;
    left: 20px;
    background: rgba(0, 0, 0, 0.75);
    border: 1px solid #4a9eff;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 12px;
    color: #fff;
    font-family: 'Courier New', monospace;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
    min-width: 160px;
  }

  .latency-label {
    font-weight: bold;
    text-align: center;
    margin-bottom: 6px;
    font-size: 11px;
    color: #4a9eff;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .latency-row {
    display: flex;
    justify-content: space-between;
    margin: 3px 0;
    padding: 2px 0;
  }

  .latency-name {
    color: #aaa;
    font-size: 11px;
  }

  .latency-value {
    color: #4aff4a;
    font-weight: bold;
    font-size: 12px;
    text-shadow: 0 0 4px rgba(74, 255, 74, 0.5);
  }

  .speed-indicator {
    position: absolute;
    top: 20px;
    right: 20px;
    background: rgba(0, 0, 0, 0.85);
    border: 2px solid #4a9eff;
    border-radius: 12px;
    padding: 16px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    animation: slideIn 0.3s ease-out;
    box-shadow: 0 4px 20px rgba(74, 158, 255, 0.3);
  }

  .speed-indicator.fast {
    border-color: #ff4a4a;
    box-shadow: 0 4px 20px rgba(255, 74, 74, 0.3);
  }

  .speed-indicator.slow {
    border-color: #4aff4a;
    box-shadow: 0 4px 20px rgba(74, 255, 74, 0.3);
  }

  .speed-icon {
    font-size: 32px;
    animation: pulse 1s ease-in-out infinite;
  }

  .speed-text {
    font-size: 28px;
    font-weight: bold;
    color: #fff;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
  }

  .speed-hint {
    font-size: 11px;
    color: #aaa;
    margin-top: 4px;
    text-align: center;
  }

  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @keyframes pulse {
    0%, 100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.1);
    }
  }
</style>
