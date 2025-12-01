<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { WasmEmulator } from '$lib/emulator';
  import type { KeyConfig, InputState } from '$lib/types';
  import { EmulationMode } from '$lib/types';
  import { DEBUG } from '$lib/config/debug';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('ClientEmulator');

  export let romData: ArrayBuffer;
  export let keyConfig: KeyConfig;
  export let playerPort: 1 | 2 | null = 1; // Which controller port this player is using (1 or 2, null for spectator)
  export let isHost: boolean = true; // true = host (runs emulator), false = guest (receives stream)
  export let emulationMode: EmulationMode = EmulationMode.STREAMING; // Mode d'émulation
  export let startPaused: boolean = false; // Start emulator in paused state (for sync)
  export let initialState: Blob | null = null; // Initial state to load (for guest sync)
  export let runEmulatorManually: boolean = false; // For lockstep sync - allows frameAdvance() to work
  export let syncedInputMode: boolean = false; // When true, inputs are NOT applied directly - only via applyInput()
  export let shader: string = ''; // Shader to apply (e.g., 'xbrz/6xbrz-linear')

  // Local input state for synced mode - tracks raw keyboard/gamepad input
  // This is read by getCurrentInputState() and only applied to virtualGamepad via applyInput()
  let localInputState: InputState = {
    a: false, b: false, x: false, y: false,
    l: false, r: false, start: false, select: false,
    up: false, down: false, left: false, right: false
  };

  const dispatch = createEventDispatcher();

  let canvas: HTMLCanvasElement;
  let emulatorContainer: HTMLDivElement;
  let emulator: WasmEmulator;
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

  // Key mapping from KeyConfig to WasmEmulator format
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
    // MODE SINGLE: Single player, simple local emulation
    // MODE DUAL: Les deux (host ET guest) exécutent l'émulateur
    // MODE STREAMING: Seulement le host
    const shouldRunEmulator = emulationMode === EmulationMode.SINGLE || isHost || emulationMode === EmulationMode.DUAL;

    if (!shouldRunEmulator) {
      logger.info('📹 Guest waiting for stream (STREAMING mode)');
      return;
    }

    if (emulationMode === EmulationMode.SINGLE) {
      logger.info('🎮 Initializing emulator in SINGLE player mode');
    } else if (emulationMode === EmulationMode.DUAL) {
      logger.info(`🎮 Initializing emulator in DUAL mode (${isHost ? 'HOST' : 'GUEST'})`);
    } else {
      logger.info('🎮 Initializing emulator in STREAMING mode (HOST)');
    }

    try {
      // Install virtual gamepads for BOTH players BEFORE creating emulator
      // Use indices 0 and 1 (standard player positions)
      // Physical gamepads will be hidden from RetroArch
      const { VirtualGamepad, installVirtualGamepad, getOriginalGetGamepads } = await import('$lib/emulator/libs/virtual-gamepad');

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

      // Get the REAL original getGamepads (captured before override in virtual-gamepad.ts)
      originalGetGamepads = getOriginalGetGamepads();
      (window as any).__originalGetGamepads = originalGetGamepads;

      // NOTE: FrameController is installed AFTER emulator initialization
      // We let the emulator run normally during init, then take control later
      // See P2PRoom.svelte startRollbackEmulation() for when it's installed

      // Create emulator instance
      // Let RetroArch handle canvas sizing naturally
      // We'll force resize to 256x224 after init for WebRTC streaming
      const emulatorOptions: any = {
        element: canvas,
        rom: new Uint8Array(romData),
        style: {
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated'
        },
        // For lockstep sync mode, we need manual control of frames
        runEmulatorManually: runEmulatorManually,
        // Shader for upscaling (e.g., 'xbrz/6xbrz-linear')
        ...(shader ? { shader } : {}),
      };

      // If initial state is provided (for guest sync), pass it to the emulator
      logger.info(`initEmulator called with initialState: ${initialState ? `Blob(${initialState.size} bytes)` : 'null'}`);
      if (initialState) {
        logger.info(`Creating emulator with initial state (${initialState.size} bytes)`);
        // Convert Blob to File object (nostalgist expects File, not Blob)
        const stateFile = new File([initialState], 'initial.state', { type: 'application/octet-stream' });
        emulatorOptions.state = stateFile;
      }

      emulator = await WasmEmulator.snes({
        ...emulatorOptions,
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
          fastforward_ratio: '0.0',         // 0.0 = unlimited (allows fast-forward with Tab)
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

      // If runEmulatorManually is true, we need to call start() explicitly
      if (runEmulatorManually) {
        logger.info('Manual emulator mode - calling start()');
        await emulator.start();
      }

      // If startPaused is true, pause immediately before any frames can run
      // This is crucial for multiplayer sync - guest must not run any frames
      // before receiving the initial state from host
      if (startPaused) {
        emulator.pause();
        running = false;
        logger.info('Emulator started in paused state');
      } else {
        running = true;
      }

      // Note: If initialState was provided, nostalgist should load it automatically
      // We can't verify here because saveState requires the emulator to be running
      // The rollback manager will verify checksums at frame 0

      dispatch('ready', { emulator });

    } catch (error) {
      logger.error('Failed to initialize emulator:', error);
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

    // In SINGLE/DUAL mode, handle keyboard locally
    // In STREAMING mode, only host handles keyboard (guest sends via P2P)
    const shouldHandleKeyboard = emulationMode === EmulationMode.SINGLE || emulationMode === EmulationMode.DUAL || isHost;
    if (!shouldHandleKeyboard || !emulator) return;

    // Speed control
    if (e.key === 'Tab') {
      e.preventDefault();
      toggleSpeed();
      return;
    }

    // Translate keyboard input to virtual gamepad based on player's selected port
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();

        // Capture timestamp for latency measurement
        lastInputTimestamp = performance.now();

        // In synced input mode, only update localInputState - don't touch virtualGamepad directly
        // The SimpleSyncManager will call applyInput() with synchronized inputs
        // IMPORTANT: Stop propagation to prevent RetroArch from receiving the event directly!
        if (syncedInputMode) {
          e.stopPropagation();
          e.stopImmediatePropagation();
          localInputState[button as keyof InputState] = true;
          break;
        }

        const mappedButton = keyMapping[button as keyof KeyConfig];

        // Use the correct virtual gamepad based on playerPort
        const virtualGamepad = playerPort === 1
          ? (window as any).__virtualGamepadP1
          : (window as any).__virtualGamepadP2;
        const expectedIndex = playerPort === 1 ? 0 : 1;

        if (virtualGamepad && mappedButton && virtualGamepad.index === expectedIndex) {
          virtualGamepad.pressButton(mappedButton);
          virtualGamepad.updateTimestamp();

          // Measure latency
          measureLatency();
        }
        break;
      }
    }
  }

  function handleKeyUp(e: KeyboardEvent) {
    // In SINGLE/DUAL mode, handle keyboard locally
    // In STREAMING mode, only host handles keyboard (guest sends via P2P)
    const shouldHandleKeyboard = emulationMode === EmulationMode.SINGLE || emulationMode === EmulationMode.DUAL || isHost;
    if (!shouldHandleKeyboard || !emulator) return;

    // Translate keyboard input to virtual gamepad based on player's selected port
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();

        // In synced input mode, only update localInputState - don't touch virtualGamepad directly
        // IMPORTANT: Stop propagation to prevent RetroArch from receiving the event directly!
        if (syncedInputMode) {
          e.stopPropagation();
          e.stopImmediatePropagation();
          localInputState[button as keyof InputState] = false;
          break;
        }

        const mappedButton = keyMapping[button as keyof KeyConfig];

        // Use the correct virtual gamepad based on playerPort
        const virtualGamepad = playerPort === 1
          ? (window as any).__virtualGamepadP1
          : (window as any).__virtualGamepadP2;
        const expectedIndex = playerPort === 1 ? 0 : 1;

        if (virtualGamepad && mappedButton && virtualGamepad.index === expectedIndex) {
          virtualGamepad.releaseButton(mappedButton);
          virtualGamepad.updateTimestamp();
        }
        break;
      }
    }
  }

  /**
   * Helper to apply a button state change - either to localInputState (synced mode)
   * or directly to virtualGamepad (normal mode)
   */
  function applyButtonChange(button: string, isPressed: boolean) {
    // In synced input mode, only update localInputState
    if (syncedInputMode) {
      localInputState[button as keyof InputState] = isPressed;
      return;
    }

    // Normal mode: apply directly to virtual gamepad
    const mappedButton = keyMapping[button as keyof KeyConfig];
    const virtualGamepad = playerPort === 1
      ? (window as any).__virtualGamepadP1
      : (window as any).__virtualGamepadP2;
    const expectedIndex = playerPort === 1 ? 0 : 1;

    if (virtualGamepad && mappedButton && virtualGamepad.index === expectedIndex) {
      if (isPressed) {
        lastInputTimestamp = performance.now();
        virtualGamepad.pressButton(mappedButton);
        measureLatency();
      } else {
        virtualGamepad.releaseButton(mappedButton);
      }
      virtualGamepad.updateTimestamp();
    }
  }

  function pollGamepad() {
    // In SINGLE/DUAL mode, poll gamepads locally
    // In STREAMING mode, only host polls (guest sends inputs via P2P)
    const shouldPoll = emulationMode === EmulationMode.SINGLE || emulationMode === EmulationMode.DUAL || isHost;
    if (!shouldPoll || !emulator || !originalGetGamepads) return;

    // In multiplayer modes (DUAL/STREAMING): Only poll gamepad when THIS window has focus
    // This prevents both host and guest from polling the same physical gamepad
    // when testing on the same machine with two browser windows
    // In SINGLE mode: Always poll - no conflict possible
    if (emulationMode !== EmulationMode.SINGLE && !document.hasFocus()) {
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
              applyButtonChange(button, isPressed);
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
              applyButtonChange(button, isPressedPlus);
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
              applyButtonChange(button, isPressedMinus);
              break;
            }
          }
        }
      }
    }
  }

  function handleGamepadConnected(e: GamepadEvent) {
    logger.debug(`🎮 Gamepad connected: ${e.gamepad.id} (index ${e.gamepad.index})`);
  }

  function handleGamepadDisconnected(e: GamepadEvent) {
    logger.debug(`🎮 Gamepad disconnected: ${e.gamepad.id} (index ${e.gamepad.index})`);
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
    if (!isHost && emulationMode !== EmulationMode.DUAL) return;

    const mappedButton = keyMapping[button as keyof KeyConfig];

    // Remote inputs go to the OTHER port (not the one the host is using)
    // If host is on port 1, remote inputs go to port 2
    // If host is on port 2, remote inputs go to port 1
    const remoteGamepad = playerPort === 1
      ? (window as any).__virtualGamepadP2
      : (window as any).__virtualGamepadP1;
    const expectedIndex = playerPort === 1 ? 1 : 0;

    if (remoteGamepad && remoteGamepad.index === expectedIndex) {
      if (pressed) {
        remoteGamepad.pressButton(mappedButton);
      } else {
        remoteGamepad.releaseButton(mappedButton);
      }
      remoteGamepad.updateTimestamp();
    }
  }

  // Apply input from InputState (for dual mode)
  export function applyInput(port: 1 | 2, input: InputState) {
    const virtualGamepad = port === 1
      ? (window as any).__virtualGamepadP1
      : (window as any).__virtualGamepadP2;
    const expectedIndex = port === 1 ? 0 : 1;

    if (!virtualGamepad) {
      logger.warn(`applyInput(${port}): virtualGamepad P${port} not found`);
      return;
    }

    if (virtualGamepad.index !== expectedIndex) {
      logger.warn(`applyInput(${port}): virtualGamepad index mismatch (got ${virtualGamepad.index}, expected ${expectedIndex})`);
      return;
    }

    // Apply all buttons
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

  // Get current input state (for dual mode)
  // In synced mode, returns localInputState (raw keyboard/gamepad state before sync)
  // In normal mode, returns the current virtualGamepad state
  export function getCurrentInputState(): InputState {
    // In synced input mode, return the raw local input state
    // This is what gets sent to the peer and then applied via applyInput()
    if (syncedInputMode) {
      return { ...localInputState };
    }

    // Normal mode: read from virtual gamepad
    const virtualGamepad = playerPort === 1
      ? (window as any).__virtualGamepadP1
      : (window as any).__virtualGamepadP2;

    if (!virtualGamepad) {
      return {
        a: false, b: false, x: false, y: false,
        l: false, r: false, start: false, select: false,
        up: false, down: false, left: false, right: false
      };
    }

    // Read current state from virtual gamepad
    // Indices must match buttonMap in virtual-gamepad.ts
    const buttons = virtualGamepad.buttons;

    return {
      b: buttons[0]?.pressed || false,      // B = index 0
      a: buttons[1]?.pressed || false,      // A = index 1
      y: buttons[2]?.pressed || false,      // Y = index 2
      x: buttons[3]?.pressed || false,      // X = index 3
      l: buttons[4]?.pressed || false,      // L = index 4
      r: buttons[5]?.pressed || false,      // R = index 5
      select: buttons[8]?.pressed || false, // Select = index 8
      start: buttons[9]?.pressed || false,  // Start = index 9
      up: buttons[12]?.pressed || false,    // Up = index 12
      down: buttons[13]?.pressed || false,  // Down = index 13
      left: buttons[14]?.pressed || false,  // Left = index 14
      right: buttons[15]?.pressed || false  // Right = index 15
    };
  }

  // Get emulator instance (for SyncManager)
  export function getEmulator(): WasmEmulator | null {
    return emulator || null;
  }

  export function pause() {
    logger.debug('pause() called, emulator:', !!emulator);
    if (emulator) {
      emulator.pause();
      running = false;
      logger.info('Emulator paused');
    }
  }

  export function resume() {
    logger.debug('resume() called, emulator:', !!emulator);
    if (emulator) {
      emulator.resume();
      running = true;
      logger.info('Emulator resumed');
    }
  }

  export async function saveState(): Promise<{ state: Blob; thumbnail?: Blob } | null> {
    if (!emulator) return null;
    try {
      return await emulator.saveState();
    } catch (error) {
      logger.error('Failed to save state:', error);
      return null;
    }
  }

  export async function loadState(state: Uint8Array | Blob) {
    if (!emulator) return;
    try {
      await emulator.loadState(state);
    } catch (error) {
      logger.error('Failed to load state:', error);
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

  // Lock canvas size after initial setup to prevent WebRTC capture issues
  let canvasResizeLocked = false;
  export function lockCanvasSize() {
    canvasResizeLocked = true;
    // Don't start monitor - it causes cropping issues
    // startCanvasSizeMonitor();
  }

  // Override resize to prevent it when locked
  const originalResize = resize;
  export function resizeIfUnlocked(width: number, height: number) {
    if (!canvasResizeLocked) {
      originalResize(width, height);
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
      logger.error('Error toggling fullscreen:', error);
    }
  }

  function handleFullscreenChange() {
    isFullscreen = !!document.fullscreenElement;
  }

  function toggleSpeed() {
    // Toggle between normal and fast
    // setSpeed() handles mode restrictions
    const newSpeed = currentSpeed === 'normal' ? 'fast' : 'normal';
    setSpeed(newSpeed);
  }

  function setSpeed(speed: 'normal' | 'fast' | 'slow') {
    // Disable speed control in dual mode to prevent desync
    // Allow in single player and streaming mode (host only runs emulator)
    if (emulationMode === EmulationMode.DUAL) {
      logger.debug('Speed control disabled in dual mode');
      return;
    }
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
        frameCount = 0;
        lastLogTime = now;
      }

      requestAnimationFrame(measureFPS);
    };

    requestAnimationFrame(measureFPS);
  }

  // Monitor canvas size and force it back to 256x224 if it changes
  let resizeObserver: ResizeObserver | null = null;

  // Canvas freeze state (to prevent black screen during resync)
  let freezeOverlay: HTMLDivElement | null = null;
  let isFrozen = false;

  /**
   * Freeze the canvas display by capturing current frame to an overlay image.
   * This prevents black screen during state loading.
   */
  export function freezeCanvas(): void {
    if (isFrozen || !canvas || !emulatorContainer) {
      logger.debug('freezeCanvas: already frozen or no canvas');
      return;
    }

    try {
      // Create overlay div
      freezeOverlay = document.createElement('div');
      freezeOverlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: flex;
        justify-content: center;
        align-items: center;
        background: #000;
        z-index: 10;
        pointer-events: none;
      `;

      // Create image from canvas - use JPEG for faster encoding
      const img = document.createElement('img');
      img.src = canvas.toDataURL('image/jpeg', 0.9);
      img.style.cssText = `
        width: auto;
        height: 100%;
        max-width: 100%;
        max-height: 100%;
        aspect-ratio: 256 / 224;
        object-fit: contain;
        image-rendering: pixelated;
        image-rendering: crisp-edges;
      `;

      freezeOverlay.appendChild(img);
      emulatorContainer.appendChild(freezeOverlay);
      isFrozen = true;

      logger.info('Canvas frozen - overlay applied');
    } catch (error) {
      logger.error('Failed to freeze canvas:', error);
    }
  }

  /**
   * Unfreeze the canvas display by removing the overlay.
   */
  export function unfreezeCanvas(): void {
    if (!isFrozen || !freezeOverlay) {
      logger.debug('unfreezeCanvas: not frozen or no overlay');
      return;
    }

    try {
      if (freezeOverlay.parentNode) {
        freezeOverlay.parentNode.removeChild(freezeOverlay);
      }
      freezeOverlay = null;
      isFrozen = false;

      logger.info('Canvas unfrozen - overlay removed');
    } catch (error) {
      logger.error('Failed to unfreeze canvas:', error);
    }
  }

  function startCanvasSizeMonitor() {
    if (!canvas || !canvasResizeLocked) return;

    resizeObserver = new ResizeObserver(() => {
      // Check if canvas internal resolution changed
      if (canvas.width !== 256 || canvas.height !== 224) {
        logger.warn(`⚠️ Canvas size changed to ${canvas.width}x${canvas.height}, forcing back to 256x224`);
        if (emulator) {
          emulator.resize({ width: 256, height: 224 });
        }
      }
    });

    resizeObserver.observe(canvas);
  }

  onMount(() => {
    // In single/dual mode, init the emulator locally
    const shouldInitEmulator = emulationMode === EmulationMode.SINGLE || isHost || emulationMode === EmulationMode.DUAL;

    if (shouldInitEmulator) {
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

    // FrameController cleanup is handled in P2PRoom.svelte

    if (speedIndicatorTimeout) clearTimeout(speedIndicatorTimeout);

    // Cleanup resize observer
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }

    // Cleanup freeze overlay
    if (freezeOverlay && freezeOverlay.parentNode) {
      freezeOverlay.parentNode.removeChild(freezeOverlay);
      freezeOverlay = null;
    }

    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
  });
</script>

<div class="emulator-container" bind:this={emulatorContainer}>
  {#if emulationMode === EmulationMode.SINGLE || isHost || emulationMode === EmulationMode.DUAL}
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
    min-height: 0; /* Allow flex item to shrink */
    display: flex;
    justify-content: center;
    align-items: center;
    background: #000;
    overflow: hidden;
    position: relative;
  }

  .emulator-container:fullscreen {
    background: #000;
    cursor: none;
  }

  .emulator-container:fullscreen canvas {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  canvas {
    /* Let height be constrained by container, width follows aspect ratio */
    width: auto;
    height: 100%;
    max-width: 100%;
    max-height: 100%;

    /* SNES native aspect ratio */
    aspect-ratio: 256 / 224;

    object-fit: contain;

    image-rendering: pixelated;
    image-rendering: crisp-edges;

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
