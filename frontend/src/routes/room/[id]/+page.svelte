<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { socket } from '$lib/api/socket';
  import { goto } from '$app/navigation';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import P2PRoom from '$lib/components/P2PRoom.svelte';
  import RoomPlayers from '$lib/components/RoomPlayers.svelte';
  import type { Room, KeyConfig } from '$lib/types';
  import { EmulationMode } from '$lib/types';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('RoomPage');

  // Check if current user is the room creator (only they can change mode)
  $: isRoomCreator = room?.createdBy === $user?.id;

  export let data;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export let params: { id: string } | undefined = undefined;

  let room: Room | null = null;
  let gameStarted = false;
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

  let keyConfig: KeyConfig = userKeyConfig;

  $: roomId = data.roomId;

  // Get current user's key configuration
  $: currentPlayer = room?.players.find(p => p.userId === $user?.id);
  $: {
    keyConfig = currentPlayer?.keyConfig || userKeyConfig;
  }

  // Determine if current player is the room host
  $: isRoomHost = room?.hostId === $user?.id;

  // Check if only 1 player in the room (single-player mode)
  $: isSinglePlayer = room?.players.length === 1;

  // Determine effective emulation mode for game start
  $: effectiveEmulationMode = isSinglePlayer ? EmulationMode.SINGLE : room?.emulationMode;

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
      logger.error('Failed to load user controls:', error);
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
      gameStarted = true;

      // Prevent scrolling when game is active
      if (browser) {
        document.body.style.overflow = 'hidden';
      }
    });

    $socket.on('game:stopped', () => {
      // Restore scrolling
      if (browser) {
        document.body.style.overflow = '';
      }

      // Redirect to home when game is stopped
      goto('/');
    });
  });

  onDestroy(() => {
    if ($socket) {
      $socket.emit('room:leave', { roomId });
      $socket.off('room:updated');
      $socket.off('game:started');
      $socket.off('game:stopped');
    }

    if (browser) {
      document.body.style.overflow = '';
    }
  });

  function startGame() {
    $socket?.emit('game:start', { roomId });
  }

  function leaveRoom() {
    goto('/');
  }

  function setEmulationMode(mode: EmulationMode) {
    if (!isRoomCreator) return;
    $socket?.emit('room:setEmulationMode', { roomId, emulationMode: mode });
  }
</script>

<div class="room-container">
  {#if !gameStarted}
    <div class="lobby">
      {#if room?.gameCoverUrl}
        <img src={room.gameCoverUrl} alt={room.gameTitle} class="game-cover" />
      {:else}
        <h1>{room?.gameTitle || t($language, 'loading')}</h1>
      {/if}

      {#if room}
        <RoomPlayers {room} {roomId} />

        <!-- Emulation Mode Toggle (only shown when 2+ players) -->
        {#if !isSinglePlayer}
          <div class="mode-toggle-container">
            <button
              class="mode-toggle"
              class:disabled={!isRoomCreator}
              disabled={!isRoomCreator}
              on:click={() => setEmulationMode(room.emulationMode === EmulationMode.DUAL ? EmulationMode.STREAMING : EmulationMode.DUAL)}
            >
              <span class="mode-label" class:active={room.emulationMode === EmulationMode.DUAL}>
                {t($language, 'dualMode')} <span class="alpha-badge">Alpha</span>
              </span>
              <span class="toggle-track">
                <span class="toggle-thumb" class:right={room.emulationMode === EmulationMode.STREAMING}></span>
              </span>
              <span class="mode-label" class:active={room.emulationMode === EmulationMode.STREAMING}>
                {t($language, 'streamingMode')}
              </span>
            </button>
            <p class="mode-description">
              {room.emulationMode === EmulationMode.DUAL ? t($language, 'dualModeDesc') : t($language, 'streamingModeDesc')}
            </p>
          </div>
        {/if}

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
  {:else if room}
    <!-- Use P2PRoom component which handles all emulation modes -->
    <P2PRoom
      {roomId}
      gameId={room.gameId}
      isHost={isRoomHost}
      {keyConfig}
      emulationMode={effectiveEmulationMode ?? EmulationMode.SINGLE}
    />
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

  .game-cover {
    width: 400px;
    height: auto;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    margin-bottom: 1rem;
  }

  h1 {
    font-size: 2rem;
    margin-bottom: 2rem;
  }

  .mode-toggle-container {
    margin: 2rem 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .mode-description {
    color: #888;
    font-size: 0.875rem;
    margin: 0;
  }

  .mode-toggle {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem;
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 1rem;
  }

  .mode-toggle:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .mode-label {
    color: #666;
    font-weight: 500;
    transition: color 0.2s;
  }

  .mode-label.active {
    color: #fff;
    font-weight: 600;
  }

  .alpha-badge {
    font-size: 0.65rem;
    padding: 0.15rem 0.4rem;
    background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
    color: #000;
    border-radius: 4px;
    font-weight: 700;
    text-transform: uppercase;
    vertical-align: middle;
    margin-left: 0.25rem;
  }

  .toggle-track {
    position: relative;
    width: 50px;
    height: 28px;
    background: #444;
    border-radius: 14px;
    transition: background 0.2s;
  }

  .toggle-thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 22px;
    height: 22px;
    background: #667eea;
    border-radius: 50%;
    transition: transform 0.2s;
  }

  .toggle-thumb.right {
    transform: translateX(22px);
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
