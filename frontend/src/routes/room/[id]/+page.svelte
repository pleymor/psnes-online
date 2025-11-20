<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { browser } from '$app/environment';
  import { socket } from '$lib/api/socket';
  import { goto } from '$app/navigation';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import ClientEmulator from '$lib/components/ClientEmulator.svelte';
  import RoomPlayers from '$lib/components/RoomPlayers.svelte';
  import PauseMenu from '$lib/components/PauseMenu.svelte';
  import { P2PManager, captureCanvasStream } from '$lib/webrtc/p2p-manager';
  import { initializeAudioCapture, getAudioStream } from '$lib/emulator/audio-capture';
  import type { Room, KeyConfig } from '$lib/types';

  export let data;

  let room: Room | null = null;
  let gameStarted = false;
  let showPauseMenu = false;
  let showToast = false;
  let toastMessage = '';
  let toastType: 'success' | 'error' = 'success';
  let userKeyConfig: KeyConfig = {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    a: 'KeyX',
    b: 'KeyZ',
    x: 'KeyS',
    y: 'KeyA',
    l: 'KeyQ',
    r: 'KeyW',
    start: 'Enter',
    select: 'ShiftRight'
  };

  let keyConfig: KeyConfig = userKeyConfig; // Will be updated by reactive statement

  // Client-side emulator state
  let emulatorComponent: ClientEmulator;
  let emulatorInstance: any;
  let p2pManager: P2PManager | null = null;
  let romData: ArrayBuffer | null = null;
  let loading = false;
  let error: string | null = null;
  let guestVideoElement: HTMLVideoElement;
  let guestStream: MediaStream | null = null; // Store stream until video element is ready
  let connectionStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  let gamepadPollInterval: number | null = null;
  let lastGamepadState: Record<string, boolean> = {};

  // Latency tracking for guest
  let inputLatency = 0;
  let totalLatency = 0;
  let latencyHistoryInput: number[] = [];
  let latencyHistoryTotal: number[] = [];
  const LATENCY_HISTORY_SIZE = 10;

  // P2P connection info
  let connectionType = 'connecting';
  let connectionRTT = 0;

  // Fullscreen state for guest
  let guestContainerElement: HTMLDivElement;

  $: roomId = data.roomId;

  // Get current user's key configuration - prefer user's personal config, then room config, then defaults
  $: currentPlayer = room?.players.find(p => p.userId === $user?.id);
  $: {
    keyConfig = currentPlayer?.keyConfig || userKeyConfig;
  }
  $: playerPort = (currentPlayer?.port ?? null) as 1 | 2 | null; // Get player's selected port (null if spectator)

  // Determine if current player is the host (Player 1)
  $: isHost = playerPort === 1;
  $: isGuest = playerPort === 2 || playerPort === null; // Player 2 or spectator

  // Check if at least one player is ready (has a port)
  $: canStartGame = room?.players.some(p => p.port !== null && p.isReady) ?? false;

  // Attach stream to video element when both are available
  $: if (guestVideoElement && guestStream) {
    guestVideoElement.srcObject = guestStream;

    // Optimize for low latency
    // @ts-ignore - Non-standard but widely supported
    if ('playsInline' in guestVideoElement) {
      guestVideoElement.playsInline = true;
    }

    // Reduce buffering for minimal latency
    try {
      // @ts-ignore - Experimental API for low latency
      if ('requestVideoFrameCallback' in guestVideoElement) {
        console.log('✅ Video frame callback available - minimal latency mode');
      }

      // Disable preload to reduce buffer
      guestVideoElement.preload = 'none';

      // Set very low latency hint (experimental)
      // @ts-ignore
      if (guestVideoElement.mozPreservesPitch !== undefined) {
        guestVideoElement.mozPreservesPitch = false;
      }

    } catch (e) {
      console.warn('Could not set low latency video options:', e);
    }

    guestVideoElement.play().catch(err => console.error('Failed to play video:', err));
  }

  async function loadROM() {
    if (!room?.gameId) return;

    try {
      loading = true;
      const response = await fetch(`/api/games/${room.gameId}/download`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to load ROM');
      }

      romData = await response.arrayBuffer();
      loading = false;

    } catch (err) {
      console.error('Failed to load ROM:', err);
      error = 'Failed to load game';
      loading = false;
    }
  }

  async function setupP2PConnection() {
    if (!$socket) {
      console.error('❌ Cannot setup P2P: Socket not connected');
      error = 'Socket not connected';
      return;
    }

    try {
      connectionStatus = 'connecting';

      // Join the P2P room via Socket.IO
      await new Promise<void>((resolve) => {
        $socket!.emit('p2p:join', { roomId });
        $socket!.once('p2p:joined', () => {
          resolve();
        });
      });

      // Initialize P2P manager
      p2pManager = new P2PManager($socket, roomId, isHost, {
        onStream: (stream) => {
          // Store stream - reactive statement will attach it when video element is ready
          guestStream = stream;
          connectionStatus = 'connected';
        },
        onData: (data) => {
          // Handle remote input (for host receiving guest input)
          if (data.type === 'input' && playerPort === 1) {
            emulatorComponent?.handleRemoteInput(data.button, data.pressed);

            // Send ACK back to guest with timestamp
            if (p2pManager && data.inputId && data.timestamp) {
              p2pManager.sendData({
                type: 'input_ack',
                inputId: data.inputId,
                timestamp: data.timestamp
              });
            }
          }

          // Handle ACK from host (for guest measuring latency)
          if (data.type === 'input_ack' && playerPort === 2) {
            const now = performance.now();
            const sendTime = data.timestamp;
            const latency = now - sendTime;

            // Update input latency (round-trip time)
            latencyHistoryInput.push(latency);
            if (latencyHistoryInput.length > LATENCY_HISTORY_SIZE) {
              latencyHistoryInput.shift();
            }
            inputLatency = latencyHistoryInput.reduce((a, b) => a + b, 0) / latencyHistoryInput.length;

            // Estimate total latency (input + 1-2 frames for video encoding/decoding)
            // At 60fps, 2 frames = ~33ms
            const estimatedVideoLatency = 33;
            const totalLat = latency + estimatedVideoLatency;

            latencyHistoryTotal.push(totalLat);
            if (latencyHistoryTotal.length > LATENCY_HISTORY_SIZE) {
              latencyHistoryTotal.shift();
            }
            totalLatency = latencyHistoryTotal.reduce((a, b) => a + b, 0) / latencyHistoryTotal.length;
          }
        },
        onConnect: async () => {
          connectionStatus = 'connected';

          // Get connection metrics for display
          if (playerPort === 2 && p2pManager) {
            setTimeout(async () => {
              const metrics = await p2pManager!.getConnectionMetrics();
              if (metrics) {
                connectionType = metrics.type;
                connectionRTT = metrics.rtt;
                console.log('📊 Connection metrics:', metrics);
              }
            }, 2000);
          }
        },
        onClose: () => {
          connectionStatus = 'disconnected';
        },
        onError: (err) => {
          console.error('P2P error:', err);
          connectionStatus = 'disconnected';
        }
      });

      // If host, wait for emulator to be ready, then capture stream
      if (isHost) {
        // Wait for emulator initialization
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Get canvas from emulator component
        const canvas = emulatorComponent?.getCanvas();

        if (canvas) {
          // Capture video from canvas
          const videoStream = captureCanvasStream(canvas, 60);

          // Try to add audio from the captured emulator audio
          const audioStream = getAudioStream();
          if (audioStream) {
            const audioTracks = audioStream.getAudioTracks();
            if (audioTracks.length > 0) {
              console.log('✅ Adding audio tracks to video stream');
              audioTracks.forEach(track => videoStream.addTrack(track));
            } else {
              console.warn('⚠️ No audio tracks in captured stream');
            }
          } else {
            console.warn('⚠️ No audio stream available');
          }

          await p2pManager.initConnection(videoStream);
        } else {
          throw new Error('Failed to get canvas from emulator');
        }
      } else {
        // Guest: just init connection (no local stream)
        await p2pManager.initConnection();
      }

    } catch (err) {
      console.error('Failed to setup P2P:', err);
      error = 'Failed to establish peer connection';
    }
  }

  function handleEmulatorReady(event: CustomEvent) {
    emulatorInstance = event.detail.emulator;

    // Setup P2P after emulator is ready (host only)
    if (isHost) {
      setupP2PConnection();
    } else {
    }
  }

  function handleGuestKeyDown(e: KeyboardEvent) {
    // Fullscreen toggle with Alt+Enter (for guest)
    if (e.altKey && e.key === 'Enter') {
      e.preventDefault();
      toggleGuestFullscreen();
      return;
    }

    // Guest sends their input to host via P2P
    if (!isGuest || !p2pManager || playerPort !== 2) return;

    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();
        const timestamp = performance.now();
        const inputId = `${button}_${timestamp}`;
        p2pManager.sendData({
          type: 'input',
          button,
          pressed: true,
          timestamp,
          inputId
        });
        break;
      }
    }
  }

  function handleGuestKeyUp(e: KeyboardEvent) {
    if (!isGuest || !p2pManager || playerPort !== 2) return;

    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();
        const timestamp = performance.now();
        const inputId = `${button}_${timestamp}`;
        p2pManager.sendData({
          type: 'input',
          button,
          pressed: false,
          timestamp,
          inputId
        });
        break;
      }
    }
  }

  function pollGamepad() {
    if (!isGuest || !p2pManager || playerPort !== 2) {
      // Debug: log why we're not polling
      return;
    }

    // IMPORTANT: Only poll gamepad when THIS window has focus
    // This prevents both host and guest from polling the same physical gamepad
    if (!document.hasFocus()) {
      return;
    }

    const gamepads = navigator.getGamepads();
    let physicalGamepadIndex = 0; // Remap physical gamepads to start from index 0

    // Debug: log gamepad detection (only once per second to avoid spam)
    if (Math.random() < 0.016) { // ~1/60th of the time
    }

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
        const inputCode = `Gamepad${configIndex}Button${j}`; // Use config index
        const isPressed = gamepad.buttons[j].pressed;
        const wasPressed = lastGamepadState[inputCode] || false;

        if (isPressed !== wasPressed) {
          lastGamepadState[inputCode] = isPressed;

          // Find which button this input is mapped to
          for (const [button, mappedInput] of Object.entries(keyConfig)) {
            if (mappedInput === inputCode) {
              const timestamp = performance.now();
              const inputId = `${button}_${timestamp}`;
              p2pManager.sendData({
                type: 'input',
                button,
                pressed: isPressed,
                timestamp,
                inputId
              });
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
              const timestamp = performance.now();
              const inputId = `${button}_${timestamp}`;
              p2pManager.sendData({
                type: 'input',
                button,
                pressed: isPressedPlus,
                timestamp,
                inputId
              });
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
              const timestamp = performance.now();
              const inputId = `${button}_${timestamp}`;
              p2pManager.sendData({
                type: 'input',
                button,
                pressed: isPressedMinus,
                timestamp,
                inputId
              });
              break;
            }
          }
        }
      }
    }
  }

  function startGamepadPolling() {
    if (gamepadPollInterval !== null) return; // Already polling

    gamepadPollInterval = window.setInterval(pollGamepad, 16); // Poll at ~60Hz
  }

  function stopGamepadPolling() {
    if (gamepadPollInterval !== null) {
      clearInterval(gamepadPollInterval);
      gamepadPollInterval = null;
      lastGamepadState = {};
    }
  }

  onMount(async () => {
    if (!$socket) {
      goto('/');
      return;
    }

    // Load user's personal control configuration
    try {
      const res = await fetch('/api/user/controls', { credentials: 'include' });
      if (res.ok) {
        const config = await res.json();
        userKeyConfig = config;
      }
    } catch (error) {
      console.error('Failed to load user controls:', error);
    }

    // Join room
    $socket.emit('room:join', { roomId });

    // Listen for room updates
    $socket.on('room:updated', (updatedRoom: Room) => {
      if (updatedRoom.id === roomId) {
        room = updatedRoom;
      }
    });

    $socket.on('game:started', async () => {
      // Set gameStarted first so video element renders
      gameStarted = true;

      // Prevent scrolling when game is active
      if (browser) {
        document.body.style.overflow = 'hidden';
      }

      // Wait for DOM to update
      await tick();

      if (isHost) {
        // Initialize audio capture BEFORE loading emulator
        initializeAudioCapture();

        // Host: Load ROM and run emulator
        await loadROM();
      } else if (isGuest) {
        // Guest: Setup P2P to receive stream (no ROM needed)
        // Video element should now exist, so stream can be attached
        await setupP2PConnection();

        // Listen for guest keyboard input (Player 2 only)
        window.addEventListener('keydown', handleGuestKeyDown);
        window.addEventListener('keyup', handleGuestKeyUp);

        // Start polling for gamepad input
        startGamepadPolling();
      }
    });

    $socket.on('game:resumed', () => {
      if (isHost && emulatorComponent) {
        emulatorComponent.resume();
      }
      showPauseMenu = false;
    });

    $socket.on('game:stopped', () => {
      gameStarted = false;
      showPauseMenu = false;

      // Stop gamepad polling
      stopGamepadPolling();

      // Cleanup P2P connection
      if (p2pManager) {
        p2pManager.destroy();
        p2pManager = null;
      }

      // Restore scrolling
      if (browser) {
        document.body.style.overflow = '';
      }
    });

    // Handle Escape key for pause menu
    if (browser) {
      window.addEventListener('keydown', handleKeyDown);
    }
  });

  onDestroy(() => {
    if ($socket) {
      $socket.emit('room:leave', { roomId });
      $socket.off('room:updated');
      $socket.off('game:started');
      $socket.off('game:resumed');
      $socket.off('game:stopped');
    }

    // Stop gamepad polling
    stopGamepadPolling();

    // Cleanup P2P connection
    if (p2pManager) {
      p2pManager.destroy();
      p2pManager = null;
    }

    if (browser) {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', handleGuestKeyDown);
      window.removeEventListener('keyup', handleGuestKeyUp);
      // Restore scrolling when leaving the page
      document.body.style.overflow = '';
    }
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && gameStarted) {
      if (!showPauseMenu) {
        // Pause the game
        if (isHost && emulatorComponent) {
          emulatorComponent.pause();
        }
        $socket?.emit('game:pause', { roomId });
        showPauseMenu = true;
      } else {
        // Resume the game
        if (isHost && emulatorComponent) {
          emulatorComponent.resume();
        }
        $socket?.emit('game:resume', { roomId });
      }
    }
  }

  async function startGame() {
    // Request fullscreen before starting the game to ensure user interaction is recent
    if (browser && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen();
      } catch (err) {
        console.log('Could not enter fullscreen:', err);
      }
    }
    $socket?.emit('game:start', { roomId });
  }

  function leaveRoom() {
    goto('/');
  }

  function toggleGuestFullscreen() {
    if (!guestContainerElement) return;

    if (!document.fullscreenElement) {
      // Enter fullscreen
      guestContainerElement.requestFullscreen().catch(err => {
        console.error('Error attempting to enable fullscreen:', err);
      });
    } else {
      // Exit fullscreen
      document.exitFullscreen();
    }
  }

  function handleControlsSaved(event: CustomEvent<{ config: KeyConfig }>) {
    // Update the room state locally so controls apply immediately
    if (room && currentPlayer) {
      currentPlayer.keyConfig = { ...event.detail.config };
      // Trigger reactivity by reassigning room
      room = { ...room };
    }
  }

  function handleNotification(event: CustomEvent<{ message: string; type: 'success' | 'error' }>) {
    toastMessage = event.detail.message;
    toastType = event.detail.type;
    showToast = true;
    setTimeout(() => {
      showToast = false;
    }, 3000);
  }
</script>

<div class="room-container">
  {#if !gameStarted}
    <div class="lobby">
      <h1>{room?.gameTitle || t($language, 'loading')}</h1>

      {#if room}
        <RoomPlayers {room} {roomId} />

        <div class="actions">
          <button on:click={startGame} class="btn-start" disabled={!canStartGame}>
            {t($language, 'startGame')}
          </button>
          <button on:click={leaveRoom} class="btn-leave">
            {t($language, 'leaveRoom')}
          </button>
        </div>
      {:else}
        <p class="loading">{t($language, 'joiningRoom')}</p>
      {/if}
    </div>
  {:else}
    <!-- Game canvas container -->
    <div class="game-canvas-container">
      {#if loading}
        <div class="loading-overlay">
          <p>Loading game...</p>
        </div>
      {:else if error}
        <div class="error-overlay">
          <p>❌ {error}</p>
        </div>
      {:else if isHost && romData}
        <!-- Host: Run emulator locally -->
        <ClientEmulator
          {romData}
          {keyConfig}
          {isHost}
          on:ready={handleEmulatorReady}
          bind:this={emulatorComponent}
        />
      {:else if isGuest}
        <!-- Guest: Receive video stream -->
        <div class="guest-stream" bind:this={guestContainerElement}>
          {#if connectionStatus === 'connecting'}
            <div class="connection-status">
              <p>🔄 Connecting to host...</p>
            </div>
          {:else if connectionStatus === 'disconnected'}
            <div class="connection-status error">
              <p>❌ Connection lost</p>
            </div>
          {/if}
          <video
            bind:this={guestVideoElement}
            autoplay
            playsinline
            muted={false}
            style="max-width: 100%; max-height: 100%; image-rendering: pixelated;"
          >
            <!-- Low latency video attributes -->
          </video>

          <!-- Latency indicator for guest -->
          {#if connectionStatus === 'connected' && playerPort === 2}
            <div class="latency-indicator">
              <div class="latency-label">Latence Guest</div>
              <div class="latency-row">
                <span class="latency-name">Input:</span>
                <span class="latency-value">{inputLatency.toFixed(1)}ms</span>
              </div>
              <div class="latency-row">
                <span class="latency-name">Input+Image:</span>
                <span class="latency-value">{totalLatency.toFixed(1)}ms</span>
              </div>
              <div class="latency-separator"></div>
              <div class="latency-row">
                <span class="latency-name">Type:</span>
                <span class="latency-value" class:p2p-direct={connectionType === 'host' || connectionType === 'srflx'} class:p2p-relay={connectionType === 'relay'}>
                  {#if connectionType === 'host'}
                    Direct P2P ✓
                  {:else if connectionType === 'srflx'}
                    P2P (STUN) ✓
                  {:else if connectionType === 'relay'}
                    Relayed ⚠
                  {:else}
                    {connectionType}
                  {/if}
                </span>
              </div>
              {#if connectionRTT > 0}
                <div class="latency-row">
                  <span class="latency-name">Network RTT:</span>
                  <span class="latency-value">{connectionRTT.toFixed(1)}ms</span>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if showPauseMenu}
      <PauseMenu
        {roomId}
        gameId={room?.gameId || ''}
        {keyConfig}
        on:resume={() => {
          if (isHost && emulatorComponent) {
            emulatorComponent.resume();
          }
          $socket?.emit('game:resume', { roomId });
        }}
        on:quit={() => $socket?.emit('game:stop', { roomId })}
        on:saved={handleControlsSaved}
        on:notification={handleNotification}
      />
    {/if}
  {/if}

  {#if showToast}
    <div class="toast toast-{toastType}">
      <span class="toast-icon">{toastType === 'success' ? '✅' : '❌'}</span>
      <span>{toastMessage}</span>
    </div>
  {/if}
</div>

<style>
  .room-container {
    height: 100vh;
    width: 100vw;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow: hidden;
  }

  .room-container:has(.lobby) {
    padding: 2rem;
  }

  .lobby {
    max-width: 800px;
    width: 100%;
    text-align: center;
  }

  h1 {
    font-size: 2.5rem;
    margin-bottom: 2rem;
  }

  .actions {
    display: flex;
    gap: 1rem;
    justify-content: center;
    margin-top: 2rem;
  }

  .btn-start {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 1rem 2rem;
    font-size: 1.125rem;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-start:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  }

  .btn-start:disabled {
    background: #333;
    color: #666;
    cursor: not-allowed;
    opacity: 0.5;
  }

  .btn-leave {
    background: #333;
    color: white;
    border: none;
    padding: 1rem 2rem;
    font-size: 1.125rem;
    border-radius: 8px;
    cursor: pointer;
  }

  .loading {
    text-align: center;
    color: #888;
    font-size: 1.125rem;
    margin: 2rem 0;
  }

  .toast {
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    background: rgba(42, 42, 42, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 1rem 1.5rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    z-index: 2000;
    animation: slideIn 0.3s ease-out;
    backdrop-filter: blur(10px);
  }

  .toast-success {
    border-left: 4px solid #4caf50;
  }

  .toast-error {
    border-left: 4px solid #f44336;
  }

  .toast-icon {
    font-size: 1.25rem;
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

  /* Game canvas container */
  .game-canvas-container {
    position: relative;
    width: 100%;
    height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #000;
  }

  .loading-overlay, .error-overlay {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
    font-size: 1.2rem;
    z-index: 10;
  }

  .error-overlay {
    color: #f44336;
  }

  .guest-stream {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    background: #000;
  }

  /* Fullscreen mode for guest video */
  .guest-stream:fullscreen {
    background: #000;
  }

  .guest-stream:fullscreen video {
    width: 100vw;
    height: 100vh;
    max-width: 100vw;
    max-height: 100vh;
    object-fit: contain;
  }

  .guest-stream video {
    /* Maintain fixed aspect ratio and prevent size variations */
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 100%;

    /* Force specific dimensions to prevent resizing */
    object-fit: contain;

    /* SNES native aspect ratio (8:7 pixel aspect ratio) */
    aspect-ratio: 256 / 224;

    image-rendering: pixelated;
    image-rendering: crisp-edges;

    /* Prevent any layout shifts */
    display: block;
  }

  .connection-status {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 1rem 2rem;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 8px;
    z-index: 5;
  }

  .connection-status.error {
    border: 2px solid #f44336;
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
    z-index: 10;
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

  .latency-value.p2p-direct {
    color: #00ff00;
    text-shadow: 0 0 6px rgba(0, 255, 0, 0.7);
  }

  .latency-value.p2p-relay {
    color: #ffaa00;
    text-shadow: 0 0 6px rgba(255, 170, 0, 0.7);
  }

  .latency-separator {
    height: 1px;
    background: rgba(255, 255, 255, 0.2);
    margin: 4px 0;
  }
</style>
