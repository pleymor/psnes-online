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

  $: roomId = data.roomId;

  // Get current user's key configuration - prefer user's personal config, then room config, then defaults
  $: currentPlayer = room?.players.find(p => p.userId === $user?.id);
  $: keyConfig = currentPlayer?.keyConfig || userKeyConfig;
  $: playerPort = (currentPlayer?.port ?? null) as 1 | 2 | null; // Get player's selected port (null if spectator)

  // Determine if current player is the host (Player 1)
  $: isHost = playerPort === 1;
  $: isGuest = playerPort === 2 || playerPort === null; // Player 2 or spectator

  // Check if at least one player is ready (has a port)
  $: canStartGame = room?.players.some(p => p.port !== null && p.isReady) ?? false;

  // Attach stream to video element when both are available
  $: if (guestVideoElement && guestStream) {
    console.log('📺 Attaching stream to video element');
    guestVideoElement.srcObject = guestStream;
    guestVideoElement.play().catch(err => console.error('Failed to play video:', err));
  }

  async function loadROM() {
    if (!room?.gameId) return;

    try {
      console.log('📥 Loading ROM...', room.gameId);
      loading = true;
      const response = await fetch(`/api/games/${room.gameId}/download`, {
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to load ROM');
      }

      romData = await response.arrayBuffer();
      console.log(`✅ ROM loaded (${romData.byteLength} bytes)`);
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
      console.log('🔗 Setting up P2P connection...', { isHost, playerPort, hasEmulator: !!emulatorComponent });
      connectionStatus = 'connecting';

      // Join the P2P room via Socket.IO
      await new Promise<void>((resolve) => {
        $socket!.emit('p2p:join', { roomId });
        $socket!.once('p2p:joined', () => {
          console.log('✅ Joined P2P room:', roomId);
          resolve();
        });
      });

      // Initialize P2P manager
      p2pManager = new P2PManager($socket, roomId, isHost, {
        onStream: (stream) => {
          console.log('📺 Received stream from host');
          // Store stream - reactive statement will attach it when video element is ready
          guestStream = stream;
          connectionStatus = 'connected';
        },
        onData: (data) => {
          console.log('📥 Received P2P data:', data, 'playerPort:', playerPort);
          // Handle remote input (for host receiving guest input)
          if (data.type === 'input' && playerPort === 1) {
            console.log('🎮 Host calling handleRemoteInput:', data.button, data.pressed);
            emulatorComponent?.handleRemoteInput(data.button, data.pressed);
          }
        },
        onConnect: () => {
          console.log('✅ P2P connected!');
          connectionStatus = 'connected';
        },
        onClose: () => {
          console.log('❌ P2P connection closed');
          connectionStatus = 'disconnected';
        },
        onError: (err) => {
          console.error('P2P error:', err);
          connectionStatus = 'disconnected';
        }
      });

      // If host, wait for emulator to be ready, then capture stream
      if (isHost) {
        console.log('🎮 Host: Waiting for emulator to stabilize...');
        // Wait for emulator initialization
        await new Promise(resolve => setTimeout(resolve, 1000));

        console.log('🎮 Host: Getting canvas from emulator component');
        // Get canvas from emulator component
        const canvas = emulatorComponent?.getCanvas();
        console.log('🎮 Host: Canvas element:', canvas ? 'found' : 'NOT FOUND');

        if (canvas) {
          console.log('🎮 Host: Capturing canvas stream at 60 FPS');
          const stream = captureCanvasStream(canvas, 60);
          console.log('🎮 Host: Initializing P2P with stream');
          await p2pManager.initConnection(stream);
        } else {
          throw new Error('Failed to get canvas from emulator');
        }
      } else {
        // Guest: just init connection (no local stream)
        console.log('🎮 Guest: Initializing P2P (no local stream)');
        await p2pManager.initConnection();
      }

    } catch (err) {
      console.error('Failed to setup P2P:', err);
      error = 'Failed to establish peer connection';
    }
  }

  function handleEmulatorReady(event: CustomEvent) {
    emulatorInstance = event.detail.emulator;
    console.log('✅ Emulator ready, isHost:', isHost, 'playerPort:', playerPort);

    // Setup P2P after emulator is ready (host only)
    if (isHost) {
      console.log('🔗 Host: Setting up P2P connection after emulator ready');
      setupP2PConnection();
    } else {
      console.log('🎮 Guest: Not setting up P2P (already done)');
    }
  }

  function handleGuestKeyDown(e: KeyboardEvent) {
    // Guest sends their input to host via P2P
    console.log('🎮 Guest keydown:', e.code, 'isGuest:', isGuest, 'p2pManager:', !!p2pManager, 'playerPort:', playerPort);
    if (!isGuest || !p2pManager || playerPort !== 2) return;

    for (const [button, keyCode] of Object.entries(keyConfig)) {
      if (e.code === keyCode) {
        e.preventDefault();
        console.log('📤 Guest sending input:', button, 'pressed');
        p2pManager.sendData({
          type: 'input',
          button,
          pressed: true
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
        console.log('📤 Guest sending input:', button, 'released');
        p2pManager.sendData({
          type: 'input',
          button,
          pressed: false
        });
        break;
      }
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
      console.log('🎮 Game starting...');

      // Set gameStarted first so video element renders
      gameStarted = true;

      // Prevent scrolling when game is active
      if (browser) {
        document.body.style.overflow = 'hidden';
      }

      // Wait for DOM to update
      await tick();

      if (isHost) {
        // Host: Load ROM and run emulator
        console.log('🎮 Host mode - loading ROM');
        await loadROM();
      } else if (isGuest) {
        // Guest: Setup P2P to receive stream (no ROM needed)
        // Video element should now exist, so stream can be attached
        console.log('🎮 Guest mode - setting up P2P connection', { isGuest, playerPort, p2pManager: !!p2pManager });
        await setupP2PConnection();

        // Listen for guest keyboard input (Player 2 only)
        console.log('🎮 Adding guest keyboard listeners', { isGuest, playerPort, p2pManager: !!p2pManager });
        window.addEventListener('keydown', handleGuestKeyDown);
        window.addEventListener('keyup', handleGuestKeyUp);
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
        <div class="guest-stream">
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
          />
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
  }

  .guest-stream video {
    max-width: 100%;
    max-height: 100%;
    image-rendering: pixelated;
    image-rendering: crisp-edges;
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
</style>
