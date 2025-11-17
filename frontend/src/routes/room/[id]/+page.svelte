<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { socket } from '$lib/api/socket';
  import { goto } from '$app/navigation';
  import { user } from '$lib/stores/user';
  import GameCanvas from '$lib/components/GameCanvas.svelte';
  import RoomPlayers from '$lib/components/RoomPlayers.svelte';
  import PauseMenu from '$lib/components/PauseMenu.svelte';
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

  $: roomId = data.roomId;

  // Get current user's key configuration - prefer user's personal config, then room config, then defaults
  $: currentPlayer = room?.players.find(p => p.userId === $user?.id);
  $: keyConfig = currentPlayer?.keyConfig || userKeyConfig;
  $: playerPort = (currentPlayer?.port ?? null) as 1 | 2 | null; // Get player's selected port (null if spectator)

  // Check if at least one player is ready (has a port)
  $: canStartGame = room?.players.some(p => p.port !== null && p.isReady) ?? false;

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

    $socket.on('game:started', () => {
      gameStarted = true;
      // Prevent scrolling when game is active
      if (browser) {
        document.body.style.overflow = 'hidden';
      }
    });

    $socket.on('game:resumed', () => {
      showPauseMenu = false;
    });

    $socket.on('game:stopped', () => {
      gameStarted = false;
      showPauseMenu = false;
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
    if (browser) {
      window.removeEventListener('keydown', handleKeyDown);
      // Restore scrolling when leaving the page
      document.body.style.overflow = '';
    }
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && gameStarted) {
      if (!showPauseMenu) {
        $socket?.emit('game:pause', { roomId });
        showPauseMenu = true;
      } else {
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
      <h1>{room?.gameTitle || 'Loading...'}</h1>

      {#if room}
        <RoomPlayers {room} {roomId} />

        <div class="actions">
          <button on:click={startGame} class="btn-start" disabled={!canStartGame}>
            Start Game
          </button>
          <button on:click={leaveRoom} class="btn-leave">
            Leave Room
          </button>
        </div>
      {:else}
        <p class="loading">Joining room...</p>
      {/if}
    </div>
  {:else}
    <GameCanvas {roomId} {keyConfig} port={playerPort} />

    {#if showPauseMenu}
      <PauseMenu
        {roomId}
        gameId={room?.gameId || ''}
        {keyConfig}
        on:resume={() => $socket?.emit('game:resume', { roomId })}
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
</style>
