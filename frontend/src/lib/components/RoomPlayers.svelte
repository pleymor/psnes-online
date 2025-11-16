<script lang="ts">
  import { socket } from '$lib/api/socket';

  export let room: any;
  export let roomId: string;

  $: player1 = room?.players?.find((p: any) => p.port === 1);
  $: player2 = room?.players?.find((p: any) => p.port === 2);

  function selectPort(port: 1 | 2) {
    $socket?.emit('room:selectPort', { roomId, port });
  }

  function toggleReady() {
    $socket?.emit('room:toggleReady', { roomId });
  }
</script>

<div class="players-container">
  <div class="ports">
    <div class="port">
      <h3>Controller 1</h3>
      {#if player1}
        <div class="player-slot filled">
          <div class="avatar">
            {#if player1.avatar}
              <img src={player1.avatar} alt={player1.displayName} />
            {:else}
              👤
            {/if}
          </div>
          <strong>{player1.displayName}</strong>
          {#if player1.isReady}
            <span class="ready">✓ Ready</span>
          {/if}
        </div>
      {:else}
        <button on:click={() => selectPort(1)} class="player-slot empty">
          Select Port 1
        </button>
      {/if}
    </div>

    <div class="port">
      <h3>Controller 2</h3>
      {#if player2}
        <div class="player-slot filled">
          <div class="avatar">
            {#if player2.avatar}
              <img src={player2.avatar} alt={player2.displayName} />
            {:else}
              👤
            {/if}
          </div>
          <strong>{player2.displayName}</strong>
          {#if player2.isReady}
            <span class="ready">✓ Ready</span>
          {/if}
        </div>
      {:else}
        <button on:click={() => selectPort(2)} class="player-slot empty">
          Select Port 2
        </button>
      {/if}
    </div>
  </div>

  <button on:click={toggleReady} class="btn-ready">
    Toggle Ready
  </button>
</div>

<style>
  .players-container {
    margin: 2rem 0;
  }

  .ports {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2rem;
    margin-bottom: 2rem;
  }

  .port {
    text-align: center;
  }

  h3 {
    font-size: 1.125rem;
    margin-bottom: 1rem;
    color: #888;
  }

  .player-slot {
    background: #2a2a2a;
    border-radius: 12px;
    padding: 2rem 1rem;
    min-height: 150px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 0.75rem;
  }

  .player-slot.empty {
    border: 2px dashed #444;
    cursor: pointer;
    color: #888;
    transition: all 0.2s;
  }

  .player-slot.empty:hover {
    border-color: #667eea;
    color: #667eea;
  }

  .player-slot.filled {
    border: 2px solid #667eea;
  }

  .avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: #1a1a1a;
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 2rem;
    overflow: hidden;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .ready {
    color: #4caf50;
    font-weight: bold;
  }

  .btn-ready {
    width: 100%;
    background: #667eea;
    color: white;
    border: none;
    padding: 1rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
  }
</style>
