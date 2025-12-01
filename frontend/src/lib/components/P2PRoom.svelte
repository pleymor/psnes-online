<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';
  import ClientEmulator from './ClientEmulator.svelte';
  import DualClientEmulator from './DualClientEmulator.svelte';
  import PauseMenu from './PauseMenu.svelte';
  import type { KeyConfig } from '$lib/types';
  import { EmulationMode } from '$lib/types';
  import { createLogger } from '$lib/utils/logger';
  import { DualModeHandler } from '$lib/multiplayer/dual-mode';
  import { StreamingModeHandler } from '$lib/multiplayer/streaming-mode';
  import { SimpleSyncManager, destroyFrameController } from '$lib/netplay';
  import type { NetplayMessage } from '$lib/netplay';
  import { createGamepadPoller, type GamepadInputCallback } from '$lib/services/gamepad';

  const logger = createLogger('P2PRoom');

  // --- Props ---
  export let roomId: string;
  export let gameId: string;
  export let isHost: boolean;
  export let keyConfig: KeyConfig;
  export let emulationMode: EmulationMode = EmulationMode.DUAL;
  export let useRollbackNetcode: boolean = true; // Enable rollback by default for dual mode
  export let useSeamlessResync: boolean = false; // Disabled - using canvas freeze instead

  // --- State ---
  let emulatorComponent: ClientEmulator;
  let dualEmulatorComponent: DualClientEmulator;
  let romData: ArrayBuffer | null = null;
  let romHash: string | null = null;
  let loading = true;
  let error: string | null = null;
  let connectionStatus: 'connecting' | 'connected' | 'disconnected' = 'connecting';

  // Streaming mode specific
  let guestVideoElement: HTMLVideoElement;
  let inputLatency = 0;
  let totalLatency = 0;

  // Pause menu
  let showPauseMenu = false;
  let wasFullscreenBeforePause = false;
  let isIntentionalFullscreenToggle = false;

  // Emulation sync state
  let waitingForGo = false; // true when emulator is ready but waiting for game:go
  let guestInitialState: Blob | null = null; // Initial state received from host (guest only)
  let guestInitialStateData: number[] | null = null; // Raw state data for syncManager
  let waitingForInitialState = false; // Guest waiting for initial state before creating emulator
  let gameGoReceived = false; // Track if game:go was received (for guest timing issue)

  // Mode handlers
  let dualHandler: DualModeHandler | null = null;
  let streamingHandler: StreamingModeHandler | null = null;
  let syncManager: SimpleSyncManager | null = null;

  // Gamepad polling for streaming mode guest
  let guestGamepadPoller = createGamepadPoller();

  // Sync stats (for debug display)
  let syncStats: { currentFrame: number; isRunning: boolean } | null = null;
  let showSyncStats = false; // Toggle with F3

  // Desync tracking - only resync after 3 consecutive desyncs
  let consecutiveDesyncs = 0;
  const DESYNC_THRESHOLD = 3;

  // --- ROM Loading ---
  async function loadROM(): Promise<void> {
    // Single player mode: just load ROM directly
    if (emulationMode === EmulationMode.SINGLE) {
      logger.info('🎮 SINGLE player: loading ROM locally');
      try {
        const response = await fetch(`/api/games/${gameId}/download`, {
          credentials: 'include'
        });

        if (!response.ok) {
          throw new Error('Failed to load ROM');
        }

        romData = await response.arrayBuffer();
        logger.debug(`✅ ROM loaded (${romData.byteLength} bytes)`);
        loading = false;
        connectionStatus = 'connected'; // No connection needed in single mode
      } catch (err) {
        logger.error('Failed to load ROM:', err);
        error = 'Failed to load game';
        loading = false;
      }
      return;
    }

    // Guest in streaming mode: no ROM needed
    if (emulationMode === EmulationMode.STREAMING && !isHost) {
      logger.info('📺 STREAMING guest: no ROM needed');
      loading = false;
      return;
    }

    // Multiplayer modes: use room-based endpoint (allows guest access)
    // Single player already handled above, so this is for DUAL or STREAMING host
    try {
      logger.debug('📥 Loading ROM...', gameId);
      // Use room-based endpoint for multiplayer (allows guest to download)
      const endpoint = emulationMode === EmulationMode.SINGLE
        ? `/api/games/${gameId}/download`
        : `/api/games/room/${roomId}/rom`;

      const response = await fetch(endpoint, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to load ROM');
      }

      romData = await response.arrayBuffer();
      logger.debug(`✅ ROM loaded (${romData.byteLength} bytes)`);

      // Compute hash for dual mode verification
      if (emulationMode === EmulationMode.DUAL) {
        romHash = await computeHash(romData);
        logger.info(`🔐 ROM hash: ${romHash}`);
      }

      loading = false;
    } catch (err) {
      logger.error('Failed to load ROM:', err);
      error = 'Failed to load game';
      loading = false;
    }
  }

  async function computeHash(data: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // --- Dual Mode Setup ---
  async function initDualMode(): Promise<void> {
    if (!$socket) {
      error = 'Socket not connected';
      return;
    }

    const shouldUseRollback = useRollbackNetcode && emulationMode === EmulationMode.DUAL;

    dualHandler = new DualModeHandler($socket, roomId, isHost, keyConfig, {
      onConnected: () => {
        connectionStatus = 'connected';
      },
      onDisconnected: () => {
        connectionStatus = 'disconnected';
        error = 'Connection lost';
      },
      onError: (msg) => {
        error = msg;
        connectionStatus = 'disconnected';
      },
      onRemoteInput: (player, inputState) => {
        // Legacy mode: direct input application
        if (!shouldUseRollback) {
          emulatorComponent?.applyInput(player, inputState);
        }
      },
      // Sync mode callbacks
      onNetplayMessage: (msg: NetplayMessage) => {
        if (syncManager) {
          syncManager.onMessage(msg);
        }
      },
      onInitialState: async (stateData: number[]) => {
        // Guest received initial state from host
        logger.info(`Guest received initial state (${stateData.length} bytes)`);

        // Store raw data for syncManager to load later
        guestInitialStateData = stateData;

        // Convert to Blob and store for emulator creation
        const arrayBuffer = new Uint8Array(stateData).buffer;
        guestInitialState = new Blob([arrayBuffer], { type: 'application/octet-stream' });

        // Compute checksum for verification
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const checksum = Array.from(new Uint8Array(hashBuffer.slice(0, 8)))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        logger.info(`Guest initial state checksum: ${checksum}`);

        // Note: syncManager doesn't exist yet - we'll load the state in startSyncEmulation
      },
      onInitialStateAck: () => {
        // Host received ACK from guest
        logger.info('Guest acknowledged initial state');
      }
    });

    // Enable rollback mode if configured
    if (shouldUseRollback) {
      dualHandler.enableRollback();
      logger.info('Rollback netcode enabled for dual mode');
    }

    try {
      if (isHost) {
        await dualHandler.initAsHost();
      } else {
        await dualHandler.initAsGuest();
      }
    } catch (err) {
      logger.error('Failed to init dual mode:', err);
      error = 'Failed to establish connection';
    }
  }

  // --- Sync Manager Setup ---
  async function initSyncManager(): Promise<void> {
    // Get emulator based on mode (only GUEST uses dual emulators for seamless resync)
    const useDualEmulator = useSeamlessResync && emulationMode === EmulationMode.DUAL && !isHost;
    const emulator = useDualEmulator
      ? dualEmulatorComponent?.getEmulator()
      : emulatorComponent?.getEmulator();

    if (!emulator || !dualHandler) {
      logger.error('Cannot init SimpleSyncManager: emulator or dualHandler not ready');
      return;
    }

    // Build callbacks
    const callbacks: any = {
      onSendMessage: (msg: NetplayMessage) => {
        dualHandler?.sendMessage(msg);
      },
      onApplyInputs: (p1: any, p2: any) => {
        if (useDualEmulator) {
          dualEmulatorComponent?.applyInput(1, p1);
          dualEmulatorComponent?.applyInput(2, p2);
        } else {
          emulatorComponent?.applyInput(1, p1);
          emulatorComponent?.applyInput(2, p2);
        }
      },
      onGetLocalInput: () => {
        const defaultInput = {
          a: false, b: false, x: false, y: false,
          l: false, r: false, start: false, select: false,
          up: false, down: false, left: false, right: false
        };
        if (useDualEmulator) {
          return dualEmulatorComponent?.getCurrentInputState() || defaultInput;
        }
        return emulatorComponent?.getCurrentInputState() || defaultInput;
      },
      onDesync: (localChecksum: string, remoteChecksum: string, frame: number) => {
        logger.error(`DESYNC at frame ${frame}!`);
        logger.error(`  Local:  ${localChecksum}`);
        logger.error(`  Remote: ${remoteChecksum}`);
      },
      onReportChecksum: (frame: number, checksum: string) => {
        $socket?.emit('sync:checksum', { roomId, frame, checksum });
      },
      // Reset desync counter after successful resync
      onResyncComplete: () => {
        logger.info('Resync complete, resetting desync counter');
        consecutiveDesyncs = 0;
      },
      // Canvas freeze callbacks for GUEST to prevent black screen during resync
      onFreezeCanvas: () => {
        if (!isHost && emulatorComponent) {
          emulatorComponent.freezeCanvas();
        }
      },
      onUnfreezeCanvas: () => {
        if (!isHost && emulatorComponent) {
          emulatorComponent.unfreezeCanvas();
        }
      }
    };

    // Add seamless swap callback for GUEST when using dual emulator mode
    if (useDualEmulator && !isHost) {
      callbacks.onLoadStateForSwap = async (stateBlob: Blob) => {
        logger.info('[P2PRoom] Seamless swap requested');
        await dualEmulatorComponent?.loadStateAndSwap(stateBlob);
      };
    }

    syncManager = new SimpleSyncManager(
      emulator,
      callbacks,
      {
        isHost,
        checksumInterval: 0, // Disabled - causes errors during gameplay
        inputDelayFrames: 2  // 2 frames of input delay for network latency
      }
    );

    // In dual emulator mode, set a getter so SimpleSyncManager always uses the active emulator
    if (useDualEmulator) {
      syncManager.setEmulatorGetter(() => {
        const emu = dualEmulatorComponent?.getEmulator();
        if (!emu) {
          logger.error('Dual emulator getter: no active emulator!');
          throw new Error('No active emulator');
        }
        return emu;
      });
    }

    logger.info(`SimpleSyncManager initialized (seamless=${useDualEmulator})`);
  }

  // --- Start Simple Synchronized Emulation ---
  async function startSyncEmulation(): Promise<void> {
    if (!syncManager || !dualHandler) {
      logger.error('Cannot start sync emulation: not initialized');
      return;
    }

    if (isHost) {
      // Host: Send initial state to guest and wait for ACK
      logger.info('HOST: Sending initial state to guest...');
      await syncManager.sendInitialState();
      logger.info('HOST: Starting sync loop');
    } else {
      // Guest: Load the initial state that was received earlier
      if (guestInitialStateData) {
        logger.info('GUEST: Loading initial state into syncManager...');
        await syncManager.loadInitialState(guestInitialStateData);
      } else {
        logger.error('GUEST: No initial state data available!');
        error = 'Failed to synchronize with host';
        return;
      }

      logger.info('GUEST: Initial state loaded, starting sync loop');
    }

    // Start the sync manager (it handles everything internally)
    syncManager.start();

    // Start stats polling loop
    startStatsLoop();
  }

  // Stats polling loop for sync manager
  let statsLoopId: ReturnType<typeof setTimeout> | null = null;

  function startStatsLoop(): void {
    if (statsLoopId !== null) return;

    const statsLoop = () => {
      if (!syncManager) {
        statsLoopId = null;
        return;
      }

      // Update stats display
      syncStats = syncManager.getStats();

      // Continue polling
      statsLoopId = setTimeout(statsLoop, 100);
    };

    statsLoop();
    logger.info('Stats loop started');
  }

  function stopStatsLoop(): void {
    if (statsLoopId !== null) {
      clearTimeout(statsLoopId);
      statsLoopId = null;
      logger.info('Stats loop stopped');
    }
  }

  // --- Streaming Mode Setup ---
  async function initStreamingMode(): Promise<void> {
    if (!$socket) {
      error = 'Socket not connected';
      return;
    }

    streamingHandler = new StreamingModeHandler($socket, roomId, isHost, keyConfig, {
      onConnected: () => {
        connectionStatus = 'connected';
      },
      onDisconnected: () => {
        connectionStatus = 'disconnected';
        error = 'Connection lost';
      },
      onError: (msg) => {
        error = msg;
        connectionStatus = 'disconnected';
      },
      onStreamReceived: (stream) => {
        if (guestVideoElement) {
          guestVideoElement.srcObject = stream;
          guestVideoElement.play();
        }
        // Guest in streaming mode: emit game:ready when stream is received
        // (since guest has no emulator, handleEmulatorReady is never called)
        if (!isHost) {
          $socket?.emit('game:ready', { roomId });
          logger.info('Guest received stream, sent game:ready');
        }
      },
      onRemoteInput: (button, pressed) => {
        emulatorComponent?.handleRemoteInput(button, pressed);
      },
      onLatencyUpdate: (input, total) => {
        inputLatency = input;
        totalLatency = total;
      }
    });

    try {
      if (isHost) {
        // Host init happens in handleEmulatorReady (needs canvas)
      } else {
        await streamingHandler.initAsGuest();
      }
    } catch (err) {
      logger.error('Failed to init streaming mode:', err);
      error = 'Failed to establish connection';
    }
  }

  // --- Emulator Ready Handler ---
  async function handleEmulatorReady(_event: CustomEvent): Promise<void> {
    logger.info(`✅ Emulator ready (${isHost ? 'HOST' : 'GUEST'}, ${emulationMode})`);

    // For multiplayer modes, wait for sync before starting
    // Note: In DUAL mode, emulator is already paused via startPaused prop
    if (emulationMode === EmulationMode.DUAL || emulationMode === EmulationMode.STREAMING) {
      // For STREAMING mode, explicitly pause (doesn't use startPaused)
      if (emulationMode === EmulationMode.STREAMING) {
        emulatorComponent?.pause();
      }
      waitingForGo = true;

      // Initialize sync manager if using sync netcode
      if (useRollbackNetcode && emulationMode === EmulationMode.DUAL) {
        await initSyncManager();

        // If game:go was already received, start sync emulation now
        if (gameGoReceived && syncManager) {
          logger.info('game:go was already received, starting sync emulation now');
          waitingForGo = false;
          await startSyncEmulation();
          return;
        }
      }

      // Signal to server that we're ready
      // Note: For DUAL mode guest with rollback, game:ready was already sent in onMount
      // before the emulator was created (since guest waits for initial state)
      if (!(useRollbackNetcode && emulationMode === EmulationMode.DUAL && !isHost)) {
        $socket?.emit('game:ready', { roomId });
        logger.info('Sent game:ready, waiting for game:go...');
      } else {
        logger.info('Guest emulator ready (game:ready was sent earlier)');
      }
    }

    // Setup mode-specific handlers (but don't start yet)
    if (emulationMode === EmulationMode.DUAL) {
      // For sync mode, input sync is handled by SimpleSyncManager
      // For legacy mode, start the old input sync
      if (!useRollbackNetcode) {
        dualHandler?.startInputSync(() => emulatorComponent?.getCurrentInputState());
      }
    } else if (isHost && streamingHandler) {
      // Host: initialize streaming with canvas
      const canvas = emulatorComponent?.getCanvas();
      if (canvas) {
        streamingHandler.initAsHost(canvas);
      }
    }
  }

  // --- Game:go Handler (start synchronized emulation) ---
  async function onGameGo(): Promise<void> {
    logger.info('🚀 Received game:go - starting emulation!');
    waitingForGo = false;
    gameGoReceived = true;

    // Start sync emulation if enabled
    if (useRollbackNetcode && emulationMode === EmulationMode.DUAL) {
      if (syncManager) {
        await startSyncEmulation();
        return;
      } else {
        // Guest: syncManager doesn't exist yet because emulator hasn't been created
        // handleEmulatorReady will call startSyncEmulation when ready
        logger.info('game:go received but syncManager not ready - will start after emulator init');
        return;
      }
    }

    // Non-rollback mode: resume the emulator normally
    if (emulatorComponent) {
      emulatorComponent.resume();
    }
  }

  // --- Pause Menu ---
  function handlePauseToggle(): void {
    if (showPauseMenu) {
      handleResume();
    } else {
      handlePause();
    }
  }

  function handlePause(): void {
    // Remember if we were in fullscreen before pausing (only if not already set by handleFullscreenChange)
    if (!wasFullscreenBeforePause) {
      wasFullscreenBeforePause = !!document.fullscreenElement;
    }
    // Stop sync loop first (if using sync mode)
    if (syncManager) {
      syncManager.stop();
    }
    // Pause the correct emulator component (only GUEST uses dual emulators)
    const useDualEmulator = useSeamlessResync && emulationMode === EmulationMode.DUAL && !isHost;
    if (useDualEmulator && dualEmulatorComponent) {
      dualEmulatorComponent.pause();
    } else if (emulatorComponent) {
      emulatorComponent.pause();
    }
    showPauseMenu = true;
    // Notify other players via server
    $socket?.emit('game:pause', { roomId });
  }

  function handleResume(): void {
    // Restart sync loop (if using sync mode) - this handles emulator state internally
    const useDualEmulator = useSeamlessResync && emulationMode === EmulationMode.DUAL && !isHost;
    if (syncManager) {
      syncManager.start();
    } else if (useDualEmulator && dualEmulatorComponent) {
      dualEmulatorComponent.resume();
    } else if (emulatorComponent) {
      emulatorComponent.resume();
    }
    showPauseMenu = false;
    wasFullscreenBeforePause = false; // Reset for next pause cycle
    // Notify other players via server
    $socket?.emit('game:resume', { roomId });
  }

  function handleQuit(): void {
    $socket?.emit('game:stop', { roomId });
  }

  function handleControlsSaved(event: CustomEvent<{ config: KeyConfig }>): void {
    // Update local keyConfig when controls are saved
    keyConfig = event.detail.config;
  }

  // --- Gamepad Input (streaming mode guest) ---
  // Map gamepad button index to SNES button using user's keyConfig
  function mapGamepadInputToButton(buttonIndex: number, isAxis: boolean, axisDirection?: 'plus' | 'minus'): string | null {
    // Build the expected keyConfig value format
    // Button: "Gamepad0Button1"
    // Axis: "Gamepad0Axis0Plus" or "Gamepad0Axis0Minus"
    let pattern: string;
    if (isAxis && axisDirection) {
      pattern = `Gamepad0Axis${buttonIndex}${axisDirection === 'plus' ? 'Plus' : 'Minus'}`;
    } else {
      pattern = `Gamepad0Button${buttonIndex}`;
    }

    // Find which SNES button maps to this gamepad input
    for (const [snesButton, configValue] of Object.entries(keyConfig)) {
      if (configValue === pattern) {
        return snesButton;
      }
    }
    return null;
  }

  const handleGuestGamepadInput: GamepadInputCallback = (buttonIndex, pressed, isAxis?: boolean, axisDirection?: 'plus' | 'minus') => {
    if (emulationMode !== EmulationMode.STREAMING || isHost) return;

    const button = mapGamepadInputToButton(buttonIndex, isAxis ?? false, axisDirection);
    if (button) {
      streamingHandler?.sendInput(button, pressed);
    }
  };

  // --- Keyboard Input ---
  function handleKeyDown(e: KeyboardEvent): void {
    // Handle Alt+Enter for fullscreen toggle (don't trigger pause menu)
    if (e.altKey && e.key === 'Enter') {
      isIntentionalFullscreenToggle = true;
      return; // Let the event bubble to ClientEmulator which handles the actual toggle
    }

    // Handle Escape for pause menu (only when menu is closed - PauseMenu handles its own Escape)
    if (e.key === 'Escape' && !showPauseMenu) {
      e.preventDefault();
      handlePauseToggle();
      return;
    }

    // F3: Toggle sync stats display
    if (e.key === 'F3' && useRollbackNetcode && emulationMode === EmulationMode.DUAL) {
      e.preventDefault();
      showSyncStats = !showSyncStats;
      return;
    }

    // Streaming mode guest: send input via P2P
    if (emulationMode === EmulationMode.STREAMING && !isHost) {
      for (const [button, keyCode] of Object.entries(keyConfig)) {
        if (e.code === keyCode) {
          e.preventDefault();
          streamingHandler?.sendInput(button, true);
          break;
        }
      }
    }
  }

  function handleKeyUp(e: KeyboardEvent): void {
    // Streaming mode guest: send input via P2P
    if (emulationMode === EmulationMode.STREAMING && !isHost) {
      for (const [button, keyCode] of Object.entries(keyConfig)) {
        if (e.code === keyCode) {
          e.preventDefault();
          streamingHandler?.sendInput(button, false);
          break;
        }
      }
    }
  }

  // --- Socket event handlers for pause sync ---
  function onGamePaused(): void {
    logger.debug('Received game:paused from server, showPauseMenu:', showPauseMenu);
    // Avoid double-pause if we already triggered it locally
    if (showPauseMenu) return;

    // Stop sync loop first (if using sync mode)
    if (syncManager) {
      syncManager.stop();
    }
    // Pause the correct emulator component (only GUEST uses dual emulators)
    const useDualEmulator = useSeamlessResync && emulationMode === EmulationMode.DUAL && !isHost;
    if (useDualEmulator && dualEmulatorComponent) {
      dualEmulatorComponent.pause();
    } else if (emulatorComponent) {
      emulatorComponent.pause();
    }
    showPauseMenu = true;
  }

  function onGameResumed(): void {
    logger.debug('Received game:resumed from server, showPauseMenu:', showPauseMenu);
    // Avoid double-resume if we already triggered it locally
    if (!showPauseMenu) return;

    // Restart sync loop (if using sync mode) - this handles emulator state internally
    const useDualEmulator = useSeamlessResync && emulationMode === EmulationMode.DUAL && !isHost;
    if (syncManager) {
      syncManager.start();
    } else if (useDualEmulator && dualEmulatorComponent) {
      dualEmulatorComponent.resume();
    } else if (emulatorComponent) {
      emulatorComponent.resume();
    }
    showPauseMenu = false;
  }

  function onSyncResult(result: {
    match: boolean;
    hostFrame: number;
    guestFrame: number;
    hostChecksum: string;
    guestChecksum: string;
  }): void {
    // Skip counting if resync is already in progress or pending
    if (syncManager?.isResyncActive()) {
      logger.debug(`Skipping sync result - resync active`);
      return;
    }

    if (result.match) {
      logger.info(`Server sync OK at ${result.hostFrame}/${result.guestFrame}: ${result.hostChecksum}`);
      // Reset consecutive desync counter on successful sync
      consecutiveDesyncs = 0;
    } else {
      consecutiveDesyncs++;
      logger.warn(`Server DESYNC ${consecutiveDesyncs}/${DESYNC_THRESHOLD} at ${result.hostFrame}/${result.guestFrame}: HOST=${result.hostChecksum} GUEST=${result.guestChecksum}`);

      // Trigger resync from HOST only after DESYNC_THRESHOLD consecutive desyncs
      if (isHost && syncManager && consecutiveDesyncs >= DESYNC_THRESHOLD) {
        logger.info(`[HOST] Triggering resync after ${consecutiveDesyncs} consecutive desyncs`);
        consecutiveDesyncs = 0; // Reset immediately to prevent repeated triggers
        syncManager.triggerResync(result.hostFrame);
      }
    }
  }

  // --- Fullscreen change handler ---
  function handleFullscreenChange(): void {
    // If this is an intentional fullscreen toggle (Alt+Enter), don't show pause menu
    if (isIntentionalFullscreenToggle) {
      isIntentionalFullscreenToggle = false;
      return;
    }

    // When exiting fullscreen (e.g., via Escape), show pause menu
    if (!document.fullscreenElement && !showPauseMenu) {
      logger.debug('Exited fullscreen, showing pause menu');
      // We were in fullscreen before this event
      wasFullscreenBeforePause = true;
      handlePause();
    }
  }

  // --- Lifecycle ---
  onMount(async () => {
    // Always add keyboard listener for pause menu (Escape key)
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    // Listen for pause/resume events from server (for multiplayer sync)
    $socket?.on('game:paused', onGamePaused);
    $socket?.on('game:resumed', onGameResumed);

    // Listen for synchronized start signal
    $socket?.on('game:go', onGameGo);

    // Listen for sync comparison results from server
    $socket?.on('sync:result', onSyncResult);

    await loadROM();

    // Single player mode: no P2P setup needed
    if (emulationMode === EmulationMode.SINGLE) {
      logger.info('🎮 Single player mode - no P2P setup needed');
      return;
    }

    if (emulationMode === EmulationMode.DUAL) {
      await initDualMode();

      // For DUAL mode with rollback, guest needs to signal ready BEFORE emulator is created
      // because guest waits for initial state from host before creating emulator
      if (useRollbackNetcode && !isHost) {
        waitingForGo = true;
        waitingForInitialState = true;
        $socket?.emit('game:ready', { roomId });
        logger.info('Guest: Sent game:ready (waiting for initial state before creating emulator)');
      }
    } else {
      await initStreamingMode();

      // Start gamepad polling for streaming mode guest
      if (!isHost) {
        guestGamepadPoller.onInput(handleGuestGamepadInput);
        guestGamepadPoller.start();
      }
    }
  });

  onDestroy(() => {
    // Stop stats loop
    stopStatsLoop();

    // Cleanup FrameController (restore original RAF)
    destroyFrameController();

    // Cleanup sync manager
    syncManager?.destroy();
    syncManager = null;

    // Cleanup gamepad polling for streaming guest
    guestGamepadPoller.offInput(handleGuestGamepadInput);
    guestGamepadPoller.stop();

    dualHandler?.destroy();
    streamingHandler?.destroy();
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    document.removeEventListener('fullscreenchange', handleFullscreenChange);
    $socket?.off('game:paused', onGamePaused);
    $socket?.off('game:resumed', onGameResumed);
    $socket?.off('game:go', onGameGo);
    $socket?.off('sync:result', onSyncResult);
  });
</script>

<div class="p2p-room" class:single-mode={emulationMode === EmulationMode.SINGLE}>
  <!-- Game Container -->
  <div class="game-container">
    {#if loading}
      <div class="status-message">
        <div class="spinner"></div>
        <p>Loading game...</p>
      </div>

    {:else if error}
      <div class="status-message error">
        <p>❌ {error}</p>
      </div>

    {:else if emulationMode === EmulationMode.SINGLE}
      <!-- SINGLE PLAYER MODE - Simple local emulation -->
      {#if romData}
        <ClientEmulator
          {romData}
          {keyConfig}
          isHost={true}
          playerPort={1}
          {emulationMode}
          on:ready={handleEmulatorReady}
          bind:this={emulatorComponent}
        />
      {/if}

    {:else if emulationMode === EmulationMode.STREAMING}
      <!-- STREAMING MODE -->
      {#if isHost}
        {#if romData}
          <ClientEmulator
            {romData}
            {keyConfig}
            {isHost}
            playerPort={1}
            {emulationMode}
            on:ready={handleEmulatorReady}
            bind:this={emulatorComponent}
          />
        {/if}
      {:else}
        <!-- Guest: Video stream -->
        <div class="guest-stream">
          <video
            bind:this={guestVideoElement}
            autoplay
            playsinline
            muted={false}
          />
          {#if connectionStatus === 'connected'}
            <div class="latency-indicator">
              <div class="latency-label">Latency</div>
              <div class="latency-row">
                <span class="latency-name">Input:</span>
                <span class="latency-value">{inputLatency.toFixed(1)}ms</span>
              </div>
              <div class="latency-row">
                <span class="latency-name">Total:</span>
                <span class="latency-value">{totalLatency.toFixed(1)}ms</span>
              </div>
            </div>
          {/if}
        </div>
      {/if}

    {:else}
      <!-- DUAL MODE - Both host and guest load ROM from server -->
      <!-- Guest waits for initial state before creating emulator -->
      <!-- Note: Don't pass initialState when using sync mode - SimpleSyncManager loads it manually -->
      {#if romData && (isHost || guestInitialState)}
        {#if useSeamlessResync && !isHost}
          <!-- Seamless resync mode (GUEST only): use dual emulators for instant swap -->
          <DualClientEmulator
            {romData}
            {keyConfig}
            {isHost}
            playerPort={2}
            startPaused={true}
            initialState={useRollbackNetcode ? null : guestInitialState}
            on:ready={handleEmulatorReady}
            bind:this={dualEmulatorComponent}
          />
        {:else}
          <!-- Standard mode (HOST always, GUEST when seamless disabled) -->
          <ClientEmulator
            {romData}
            {keyConfig}
            {isHost}
            playerPort={isHost ? 1 : 2}
            {emulationMode}
            startPaused={true}
            initialState={useRollbackNetcode ? null : guestInitialState}
            runEmulatorManually={useRollbackNetcode}
            syncedInputMode={useRollbackNetcode}
            on:ready={handleEmulatorReady}
            bind:this={emulatorComponent}
          />
        {/if}
      {:else if romData && !isHost}
        <div class="status-message">
          <div class="spinner"></div>
          <p>Waiting for host...</p>
        </div>
      {:else}
        <div class="status-message">
          <div class="spinner"></div>
          <p>Loading ROM...</p>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Mode indicator (multiplayer only) -->
  {#if emulationMode !== EmulationMode.SINGLE}
    <div class="mode-indicator" class:dual={emulationMode === EmulationMode.DUAL} class:streaming={emulationMode === EmulationMode.STREAMING}>
      <span class="mode-icon">{emulationMode === EmulationMode.DUAL ? '⚡' : '📹'}</span>
      <span class="mode-name">{emulationMode === EmulationMode.DUAL ? 'Dual' : 'Streaming'}</span>
    </div>
  {/if}

  <!-- Waiting for sync overlay -->
  {#if waitingForGo}
    <div class="sync-overlay">
      <div class="sync-message">
        <div class="spinner"></div>
        <p>Waiting for other players...</p>
      </div>
    </div>
  {/if}

  <!-- Sync Stats (F3 to toggle) -->
  {#if showSyncStats && syncStats}
    <div class="rollback-stats">
      <div class="stats-title">Simple Sync</div>
      <div class="stats-row">
        <span>Frame:</span>
        <span>{syncStats.currentFrame}</span>
      </div>
      <div class="stats-row">
        <span>Running:</span>
        <span>{syncStats.isRunning ? 'Yes' : 'No'}</span>
      </div>
      <div class="stats-hint">F3: Hide</div>
    </div>
  {/if}

  <!-- Pause Menu -->
  {#if showPauseMenu}
    <PauseMenu
      {roomId}
      {gameId}
      {keyConfig}
      emulator={emulatorComponent}
      restoreFullscreen={wasFullscreenBeforePause}
      on:resume={handleResume}
      on:quit={handleQuit}
      on:saved={handleControlsSaved}
    />
  {/if}
</div>

<style>
  .p2p-room {
    width: 100%;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: #1a1a1a;
    color: white;
  }

  /* Game Container */
  .game-container {
    flex: 1;
    min-height: 0; /* Allow flex item to shrink below content size */
    display: flex;
    justify-content: center;
    align-items: center;
    background: #000;
    overflow: hidden;
  }

  .status-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    text-align: center;
    font-size: 1.2rem;
    color: #8ab4f8;
  }

  .status-message.error {
    color: #f44336;
  }

  .status-message .hint {
    font-size: 0.85rem;
    color: #666;
    font-family: monospace;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(138, 180, 248, 0.3);
    border-top-color: #8ab4f8;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Sync overlay */
  .sync-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 900;
  }

  .sync-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    text-align: center;
    color: #8ab4f8;
    font-size: 1.2rem;
  }

  /* Streaming Mode Guest */
  .guest-stream {
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;
  }

  .guest-stream video {
    max-width: 100%;
    max-height: 100%;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
  }

  .latency-indicator {
    position: absolute;
    bottom: 20px;
    left: 20px;
    background: rgba(0, 0, 0, 0.8);
    border: 1px solid #4a9eff;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 12px;
    font-family: monospace;
    min-width: 140px;
  }

  .latency-label {
    font-weight: bold;
    text-align: center;
    margin-bottom: 6px;
    font-size: 11px;
    color: #4a9eff;
    text-transform: uppercase;
  }

  .latency-row {
    display: flex;
    justify-content: space-between;
    margin: 3px 0;
  }

  .latency-name {
    color: #888;
  }

  .latency-value {
    color: #4aff4a;
    font-weight: bold;
  }

  /* Mode indicator */
  .mode-indicator {
    position: fixed;
    bottom: 20px;
    right: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-radius: 8px;
    border: 2px solid;
    font-size: 13px;
    background: rgba(0, 0, 0, 0.7);
    z-index: 100;
  }

  .mode-indicator.dual {
    border-color: #4aff4a;
  }

  .mode-indicator.streaming {
    border-color: #4a9eff;
  }

  .mode-icon {
    font-size: 16px;
  }

  .mode-name {
    font-weight: bold;
  }

  /* Rollback Stats */
  .rollback-stats {
    position: fixed;
    top: 20px;
    left: 20px;
    background: rgba(0, 0, 0, 0.85);
    border: 2px solid #4aff4a;
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 12px;
    font-family: 'Courier New', monospace;
    min-width: 180px;
    z-index: 200;
  }

  .stats-title {
    font-weight: bold;
    text-align: center;
    margin-bottom: 8px;
    font-size: 11px;
    color: #4aff4a;
    text-transform: uppercase;
    letter-spacing: 1px;
    border-bottom: 1px solid #4aff4a;
    padding-bottom: 6px;
  }

  .stats-row {
    display: flex;
    justify-content: space-between;
    margin: 4px 0;
    color: #ccc;
  }

  .stats-row span:last-child {
    color: #fff;
    font-weight: bold;
  }

  .stats-row .warning {
    color: #ffaa00;
  }

  .stats-row .error {
    color: #ff4444;
  }

  .stats-hint {
    font-size: 10px;
    color: #666;
    text-align: center;
    margin-top: 8px;
    border-top: 1px solid #333;
    padding-top: 6px;
  }
</style>
