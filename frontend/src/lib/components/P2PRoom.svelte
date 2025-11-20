<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';
  import ClientEmulator from './ClientEmulator.svelte';
  import { P2PManager, captureCanvasStream } from '$lib/webrtc/p2p-manager';
  import type { KeyConfig } from '$lib/types';

  export let roomId: string;
  export let gameId: string;
  export let isHost: boolean;
  export let keyConfig: KeyConfig;

  let emulatorComponent: ClientEmulator; // ClientEmulator component
  let emulatorInstance: any; // Nostalgist emulator instance
  let p2pManager: P2PManager | null = null;
  let romData: ArrayBuffer | null = null;
  let loading = true;
  let error: string | null = null;
  let guestVideoElement: HTMLVideoElement;
  let connectionStatus: 'connecting' | 'connected' | 'disconnected' = 'connecting';

  async function loadROM() {
    try {
      const response = await fetch(`/api/games/${gameId}/download`, {
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
      error = 'Socket not connected';
      return;
    }

    try {
      // First, join the Socket.IO room
      await new Promise<void>((resolve) => {
        $socket!.emit('p2p:join', { roomId });
        $socket!.once('p2p:joined', () => {
          resolve();
        });
      });

      // Initialize P2P manager
      p2pManager = new P2PManager($socket, roomId, isHost, {
        onStream: (stream) => {
          // Attach stream to video element (for guest)
          if (guestVideoElement) {
            guestVideoElement.srcObject = stream;
            guestVideoElement.play();
          }
          connectionStatus = 'connected';
        },
        onData: (data) => {
          // Handle remote input (for host receiving guest input)
          if (data.type === 'input' && isHost) {
            emulatorComponent?.handleRemoteInput(data.button, data.pressed);
          }
        },
        onConnect: () => {
          connectionStatus = 'connected';
        },
        onClose: () => {
          connectionStatus = 'disconnected';
          error = 'Connection lost';
        },
        onError: (err) => {
          console.error('P2P error:', err);
          error = `Connection error: ${err.message}`;
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
          const stream = captureCanvasStream(canvas, 60);
          await p2pManager.initConnection(stream);
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
    setupP2PConnection();
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Guest sends their input to host via P2P
    if (!isHost && p2pManager) {
      for (const [button, keyCode] of Object.entries(keyConfig)) {
        if (e.code === keyCode) {
          e.preventDefault();
          p2pManager.sendData({
            type: 'input',
            button,
            pressed: true
          });
          break;
        }
      }
    }
  }

  function handleKeyUp(e: KeyboardEvent) {
    if (!isHost && p2pManager) {
      for (const [button, keyCode] of Object.entries(keyConfig)) {
        if (e.code === keyCode) {
          e.preventDefault();
          p2pManager.sendData({
            type: 'input',
            button,
            pressed: false
          });
          break;
        }
      }
    }
  }

  onMount(async () => {
    // Load ROM
    await loadROM();

    // For guest, setup P2P immediately after ROM is loaded
    if (!isHost) {
      await setupP2PConnection();
    }

    // Listen for keyboard (guest input)
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
  });

  onDestroy(() => {
    if (p2pManager) {
      p2pManager.destroy();
    }
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
  });
</script>

<div class="p2p-room">
  <div class="room-header">
    <div class="role-badge" class:host={isHost} class:guest={!isHost}>
      {isHost ? '👑 HOST' : '🎮 GUEST'}
    </div>
    <div class="connection-status" class:connected={connectionStatus === 'connected'}>
      {#if connectionStatus === 'connecting'}
        🔄 Connecting...
      {:else if connectionStatus === 'connected'}
        ✅ Connected (P2P)
      {:else}
        ❌ Disconnected
      {/if}
    </div>
  </div>

  <div class="game-container">
    {#if loading}
      <div class="loading">
        <p>Loading game...</p>
      </div>
    {:else if error}
      <div class="error">
        <p>❌ {error}</p>
      </div>
    {:else if romData}
      {#if isHost}
        <!-- Host: Run emulator locally -->
        <ClientEmulator
          {romData}
          {keyConfig}
          {isHost}
          on:ready={handleEmulatorReady}
          bind:this={emulatorComponent}
        />
      {:else}
        <!-- Guest: Receive video stream -->
        <div class="guest-stream">
          <video
            bind:this={guestVideoElement}
            autoplay
            playsinline
            muted={false}
          />
        </div>
      {/if}
    {/if}
  </div>

  <div class="info-panel">
    <p class="hint">
      {#if isHost}
        🎮 You are hosting this game. Press keys to play. Your gameplay is streamed to guests.
      {:else}
        🎮 Watching host's gameplay. Press keys to control Player 2.
      {/if}
    </p>
  </div>
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

  .room-header {
    padding: 1rem;
    background: #2a2a2a;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 2px solid #667eea;
  }

  .role-badge {
    padding: 0.5rem 1rem;
    border-radius: 20px;
    font-weight: bold;
    font-size: 0.9rem;
  }

  .role-badge.host {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  }

  .role-badge.guest {
    background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
  }

  .connection-status {
    padding: 0.5rem 1rem;
    border-radius: 20px;
    background: #444;
    font-size: 0.9rem;
  }

  .connection-status.connected {
    background: #4caf50;
  }

  .game-container {
    flex: 1;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 2rem;
    background: #000;
  }

  .loading, .error {
    text-align: center;
    font-size: 1.2rem;
  }

  .error {
    color: #f44336;
  }

  .guest-stream {
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

  .info-panel {
    padding: 1rem;
    background: #2a2a2a;
    border-top: 1px solid #444;
  }

  .hint {
    margin: 0;
    color: #aaa;
    font-size: 0.9rem;
    text-align: center;
  }
</style>
