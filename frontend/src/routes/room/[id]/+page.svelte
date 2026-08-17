<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { socket } from '$lib/api/socket';
  import type { Socket } from 'socket.io-client';
  import { goto } from '$app/navigation';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import P2PRoom from '$lib/components/P2PRoom.svelte';
  import LockstepRoom from '$lib/components/LockstepRoom.svelte';
  import RoomPlayers from '$lib/components/RoomPlayers.svelte';
  import type { Room, KeyConfig } from '$lib/types';
  import { EmulationMode } from '$lib/types';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('RoomPage');

  // Check if current user is the room creator (only they can change mode)
  $: isRoomCreator = room?.createdBy === $user?.id;

  export let data;

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

  /**
   * The mode the running game was started in, frozen at `game:started`.
   *
   * `effectiveEmulationMode` is derived from the live player count, so a single
   * `room:updated` carrying one player - a socket.io reconnect is enough, and
   * the emulator stalling the main thread makes those routine - flipped it to
   * SINGLE mid-game. That swapped the rendered component, which destroyed the
   * running emulator and mounted an independent single-player one; when the
   * peer came back it was rebuilt from scratch and the game restarted. A game
   * in progress keeps the mode it began with.
   */
  let activeEmulationMode: EmulationMode | null = null;

  // Check if at least one player is ready (has a port)
  $: canStartGame = room?.players.some(p => p.port !== null && p.isReady) ?? false;

  /**
   * Waits for the shared socket to exist.
   *
   * The layout creates it in its own onMount, after awaiting /auth/me - and a
   * child's onMount runs before its parent's. Bailing out on a null socket
   * therefore bounced every direct visit to a room URL back to the library,
   * which is every shared invite link and every page refresh mid-lobby.
   */
  function waitForSocket(timeoutMs = 10000): Promise<Socket | null> {
    if ($socket) return Promise.resolve($socket);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(null);
      }, timeoutMs);
      const unsubscribe = socket.subscribe((value) => {
        if (!value) return;
        clearTimeout(timer);
        // Defer: subscribe fires synchronously, before `unsubscribe` is bound.
        queueMicrotask(() => unsubscribe());
        resolve(value);
      });
    });
  }

  onMount(async () => {
    const sock = await waitForSocket();
    if (!sock) {
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
    sock.emit('room:join', { roomId });

    // Rejoin after a reconnect. The server drops a player from the room when
    // its socket disconnects, and socket.io reconnects on its own - but
    // `room:join` only ran in onMount, so the player stayed dropped. The room
    // then sat at one player permanently, which is also what pushed a running
    // game into single-player mode.
    sock.on('connect', () => {
      logger.info('Socket reconnected, rejoining room');
      sock.emit('room:join', { roomId });
    });

    // Listen for room updates
    sock.on('room:updated', (updatedRoom: Room) => {
      if (updatedRoom.id === roomId) {
        room = updatedRoom;
      }
    });

    sock.on('game:started', async () => {
      activeEmulationMode = effectiveEmulationMode ?? EmulationMode.SINGLE;
      gameStarted = true;

      // Prevent scrolling when game is active
      if (browser) {
        document.body.style.overflow = 'hidden';
      }
    });

    sock.on('game:stopped', () => {
      activeEmulationMode = null;
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
      $socket.off('connect');
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

  // Lockstep first: it is the only mode that cannot silently drift apart, and
  // it is now the default for new rooms. Dual is last - it is still the one
  // that desyncs.
  const modeOptions = [
    { mode: EmulationMode.LOCKSTEP, label: 'lockstepMode', badge: '' },
    { mode: EmulationMode.STREAMING, label: 'streamingMode', badge: '' },
    { mode: EmulationMode.DUAL, label: 'dualMode', badge: 'Alpha' }
  ] as const;

  function modeDescriptionKey(mode: EmulationMode | undefined) {
    if (mode === EmulationMode.DUAL) return 'dualModeDesc' as const;
    if (mode === EmulationMode.LOCKSTEP) return 'lockstepModeDesc' as const;
    return 'streamingModeDesc' as const;
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

        <!-- Emulation Mode selector (only shown when 2+ players).
             Three modes now rather than two, so a segmented control replaces
             the old on/off toggle. -->
        {#if !isSinglePlayer}
          <div class="mode-toggle-container">
            <div class="mode-segments" role="group" aria-label={t($language, 'emulationMode')}>
              {#each modeOptions as option}
                <button
                  type="button"
                  class="mode-segment"
                  class:active={room.emulationMode === option.mode}
                  disabled={!isRoomCreator}
                  aria-pressed={room.emulationMode === option.mode}
                  on:click={() => setEmulationMode(option.mode)}
                >
                  {t($language, option.label)}
                  {#if option.badge}<span class="alpha-badge">{option.badge}</span>{/if}
                </button>
              {/each}
            </div>
            <p class="mode-description">{t($language, modeDescriptionKey(room.emulationMode))}</p>
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
    {#if activeEmulationMode === EmulationMode.LOCKSTEP}
      <!-- Lockstep runs on its own deterministic core and its own relay, so it
           shares nothing with the WebRTC path in P2PRoom. -->
      <LockstepRoom {roomId} gameId={room.gameId} gameCrc32={room.gameCrc32} gameTitle={room.gameTitle} isHost={isRoomHost} {keyConfig} />
    {:else}
      <!-- P2PRoom handles the single, dual and streaming modes -->
      <P2PRoom
        {roomId}
        gameId={room.gameId}
        gameCrc32={room.gameCrc32}
        gameTitle={room.gameTitle}
        isHost={isRoomHost}
        {keyConfig}
        emulationMode={activeEmulationMode ?? EmulationMode.SINGLE}
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

  .mode-segments {
    display: inline-flex;
    background: #2a2a3a;
    border: 1px solid #3d3d52;
    border-radius: 10px;
    padding: 0.25rem;
    gap: 0.25rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .mode-segment {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: transparent;
    border: none;
    border-radius: 7px;
    color: #8b8ba3;
    font-size: 0.95rem;
    font-weight: 500;
    padding: 0.45rem 1rem;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .mode-segment:hover:not(:disabled):not(.active) {
    color: #d6d6e6;
  }

  .mode-segment.active {
    background: #667eea;
    color: #fff;
    font-weight: 600;
  }

  .mode-segment:disabled {
    cursor: not-allowed;
  }

  /* Only the creator can change the mode; everyone else still needs to read
     which mode is selected, so dim the unselected options rather than the
     whole control. */
  .mode-segment:disabled:not(.active) {
    opacity: 0.55;
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
