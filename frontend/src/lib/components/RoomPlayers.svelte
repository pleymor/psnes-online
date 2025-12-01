<script lang="ts">
  import { socket } from '$lib/api/socket';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';

  export let room: any;
  export let roomId: string;

  $: player1 = room?.players?.find((p: any) => p.port === 1);
  $: player2 = room?.players?.find((p: any) => p.port === 2);
  $: currentPlayer = room?.players?.find((p: any) => p.userId === $user?.id);
  $: currentPlayerPort = currentPlayer?.port;

  // Check if only 1 player in the room (single-player mode)
  $: isSinglePlayer = room?.players?.length === 1;

  function handlePortClick(port: 1 | 2) {
    // In single-player mode, controller 2 is disabled
    if (isSinglePlayer && port === 2) {
      return;
    }

    // If already on this port, do nothing (no unselecting)
    if (currentPlayerPort === port) {
      return;
    }

    // Select/switch to that port
    $socket?.emit('room:selectPort', { roomId, port });
  }
</script>

<div class="players">
  <button
    class="player"
    class:mine={player1?.userId === $user?.id}
    class:occupied={player1 && player1?.userId !== $user?.id}
    on:click={() => handlePortClick(1)}
  >
    <span class="port-label">{t($language, 'player1')}</span>
    {#if player1?.avatar}
      <img src={player1.avatar} alt="" class="avatar" />
    {/if}
    <span class="player-name">{player1?.displayName || '—'}</span>
  </button>

  <button
    class="player"
    class:mine={player2?.userId === $user?.id}
    class:occupied={player2 && player2?.userId !== $user?.id}
    class:disabled={isSinglePlayer}
    disabled={isSinglePlayer}
    on:click={() => handlePortClick(2)}
  >
    <span class="port-label">{t($language, 'player2')}</span>
    {#if player2?.avatar}
      <img src={player2.avatar} alt="" class="avatar" />
    {/if}
    <span class="player-name">{player2?.displayName || '—'}</span>
  </button>
</div>

<style>
  .players {
    display: flex;
    gap: 2rem;
    justify-content: center;
    margin: 1rem 0;
  }

  .player {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 1.5rem 2rem;
    background: #2a2a2a;
    border: 2px solid #444;
    border-radius: 12px;
    color: #888;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.2s;
    min-width: 180px;
  }

  .player:hover:not(:disabled) {
    border-color: #667eea;
    color: #fff;
  }

  .player.mine {
    border-color: #667eea;
    background: rgba(102, 126, 234, 0.15);
    color: #fff;
  }

  .player.occupied {
    border-color: #4caf50;
    color: #fff;
  }

  .player:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .port-label {
    font-weight: 700;
    font-size: 1rem;
    padding: 0.35rem 0.75rem;
    background: #444;
    border-radius: 6px;
    color: #aaa;
  }

  .player.mine .port-label {
    background: #667eea;
    color: #fff;
  }

  .player.occupied .port-label {
    background: #4caf50;
    color: #fff;
  }

  .avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    object-fit: cover;
  }

  .player-name {
    font-weight: 600;
    font-size: 1.1rem;
  }

  @media (max-width: 480px) {
    .players {
      flex-direction: column;
      align-items: center;
    }
  }
</style>
