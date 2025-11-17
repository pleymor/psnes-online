<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import { socket } from '$lib/api/socket';
  import { goto } from '$app/navigation';
  import { user } from '$lib/stores/user';
  import GameCanvas from '$lib/components/GameCanvas.svelte';
  import RoomPlayers from '$lib/components/RoomPlayers.svelte';
  import PauseMenu from '$lib/components/PauseMenu.svelte';
  import type { Room, KeyConfig } from '$lib/types';

  let room: Room | null = null;
  let gameStarted = false;
  let isPaused = false;
  let showPauseMenu = false;
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

  $: roomId = $page.params.id as string;

  // Get current user's key configuration - prefer user's personal config, then room config, then defaults
  $: currentPlayer = room?.players.find(p => p.userId === $user?.id);
  $: keyConfig = currentPlayer?.keyConfig || userKeyConfig;

  onMount(async () => {
    if (!$socket) {
      goto('/library');
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

    $socket.on('game:paused', () => {
      isPaused = true;
    });

    $socket.on('game:resumed', () => {
      isPaused = false;
      showPauseMenu = false;
    });

    $socket.on('game:stopped', () => {
      gameStarted = false;
      isPaused = false;
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
      $socket.off('game:paused');
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

  function startGame() {
    $socket?.emit('game:start', { roomId });
  }

  function leaveRoom() {
    goto('/library');
  }

  function handleControlsSaved(event: CustomEvent<{ config: KeyConfig }>) {
    // Update the room state locally so controls apply immediately
    if (room && currentPlayer) {
      currentPlayer.keyConfig = { ...event.detail.config };
      // Trigger reactivity by reassigning room
      room = { ...room };
    }
  }
</script>

<div class="room-container">
  {#if !gameStarted}
    <div class="lobby">
      <h1>{room?.gameTitle || 'Loading...'}</h1>

      <RoomPlayers {room} {roomId} />

      <div class="actions">
        <button on:click={startGame} class="btn-start">
          Start Game
        </button>
        <button on:click={leaveRoom} class="btn-leave">
          Leave Room
        </button>
      </div>
    </div>
  {:else}
    <GameCanvas {roomId} {keyConfig} />

    {#if showPauseMenu}
      <PauseMenu
        {roomId}
        {keyConfig}
        on:resume={() => $socket?.emit('game:resume', { roomId })}
        on:quit={() => $socket?.emit('game:stop', { roomId })}
        on:saved={handleControlsSaved}
      />
    {/if}
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
</style>
