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

  function handlePortClick(port: 1 | 2) {
    // If clicking on your own port, release it
    if (currentPlayerPort === port) {
      $socket?.emit('room:unselectPort', { roomId });
    } else {
      // Otherwise, select/switch to that port
      $socket?.emit('room:selectPort', { roomId, port });
    }
  }
</script>

<div class="players-container">
  <div class="ports">
    <div class="port" class:selected={currentPlayerPort === 1}>
      <h3>🎮 {t($language, 'controller1')}</h3>
      <button
        on:click={() => handlePortClick(1)}
        class="player-slot"
        class:filled={player1}
        class:mine={player1?.userId === $user?.id}
      >
        <span class="icon">🎮</span>
        <span class="player-name">{player1?.displayName || t($language, 'joinAsPlayer1')}</span>
        {#if player1}
          <span class="ready-badge">✓ {t($language, 'ready')}</span>
        {/if}
      </button>
    </div>

    <div class="port" class:selected={currentPlayerPort === 2}>
      <h3>🎮 {t($language, 'controller2')}</h3>
      <button
        on:click={() => handlePortClick(2)}
        class="player-slot"
        class:filled={player2}
        class:mine={player2?.userId === $user?.id}
      >
        <span class="icon">🎮</span>
        <span class="player-name">{player2?.displayName || t($language, 'joinAsPlayer2')}</span>
        {#if player2}
          <span class="ready-badge">✓ {t($language, 'ready')}</span>
        {/if}
      </button>
    </div>
  </div>
</div>

<style>
  .players-container {
    margin: 2rem 0;
  }

  .ports {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
  }

  .port {
    text-align: center;
    border-radius: 16px;
    padding: 1rem;
    transition: all 0.3s;
  }

  .port.selected {
    background: rgba(102, 126, 234, 0.1);
    box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.5);
  }

  h3 {
    font-size: 1.25rem;
    margin-bottom: 1rem;
    color: #aaa;
    font-weight: 600;
  }

  .port.selected h3 {
    color: #667eea;
  }

  .player-slot {
    width: 100%;
    background: #2a2a2a;
    border-radius: 12px;
    padding: 2rem 1rem;
    min-height: 160px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 0.75rem;
    border: 2px dashed #444;
    cursor: pointer;
    color: #888;
    font-size: 1rem;
    font-weight: 500;
    transition: all 0.2s;
  }

  .player-slot:hover {
    border-color: #667eea;
    background: rgba(102, 126, 234, 0.05);
    color: #667eea;
    transform: translateY(-2px);
  }

  .player-slot.filled {
    border: 2px solid #4caf50;
    background: rgba(76, 175, 80, 0.05);
    color: #fff;
  }

  .player-slot.filled:hover {
    border-color: #4caf50;
    background: rgba(76, 175, 80, 0.08);
  }

  .player-slot.mine {
    border-color: #667eea;
    background: rgba(102, 126, 234, 0.1);
  }

  .player-slot.mine:hover {
    border-color: #ff8a80;
    background: rgba(211, 47, 47, 0.1);
  }

  .icon {
    font-size: 2.5rem;
    display: block;
  }

  .player-name {
    font-size: 1.125rem;
    font-weight: 600;
  }

  .ready-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: #4caf50;
    font-weight: 600;
    font-size: 0.85rem;
    padding: 0.25rem 0.75rem;
    background: rgba(76, 175, 80, 0.15);
    border-radius: 12px;
    border: 1px solid rgba(76, 175, 80, 0.3);
  }

  @media (max-width: 768px) {
    .ports {
      grid-template-columns: 1fr;
      gap: 1.5rem;
    }
  }
</style>
