<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import { socket } from '$lib/api/socket';
  import { goto } from '$app/navigation';
  import GameCanvas from '$lib/components/GameCanvas.svelte';
  import RoomPlayers from '$lib/components/RoomPlayers.svelte';
  import PauseMenu from '$lib/components/PauseMenu.svelte';

  let room: any = null;
  let gameStarted = false;
  let isPaused = false;
  let showPauseMenu = false;

  $: roomId = $page.params.id as string;

  onMount(() => {
    if (!$socket) {
      goto('/library');
      return;
    }

    // Join room
    $socket.emit('room:join', { roomId });

    // Listen for room updates
    $socket.on('room:updated', (updatedRoom: any) => {
      if (updatedRoom.id === roomId) {
        room = updatedRoom;
      }
    });

    $socket.on('game:started', () => {
      gameStarted = true;
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
    <GameCanvas {roomId} />

    {#if showPauseMenu}
      <PauseMenu
        {roomId}
        on:resume={() => $socket?.emit('game:resume', { roomId })}
        on:quit={() => $socket?.emit('game:stop', { roomId })}
      />
    {/if}
  {/if}
</div>

<style>
  .room-container {
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
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
