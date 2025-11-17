<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Game } from '$lib/stores/games';

  export let game: Game;

  const dispatch = createEventDispatcher();

  async function deleteGame() {
    if (confirm(`Delete "${game.title}"?`)) {
      await fetch(`/api/games/${game.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      location.reload();
    }
  }
</script>

<div class="game-card">
  <div class="cover">
    {#if game.coverUrl}
      <img src={game.coverUrl} alt={game.title} />
    {:else}
      <div class="placeholder">🎮</div>
    {/if}
  </div>

  <div class="info">
    <h3>{game.title}</h3>
    <p class="saves">{game.saves?.length || 0} save states</p>
  </div>

  <div class="actions">
    <button on:click={() => dispatch('play')} class="btn-play">
      Play
    </button>
    <button on:click={deleteGame} class="btn-delete">
      Delete
    </button>
  </div>
</div>

<style>
  .game-card {
    background: rgba(42, 42, 42, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    overflow: hidden;
    transition: all 0.3s ease;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }

  .game-card:hover {
    transform: translateY(-8px);
    box-shadow: 0 12px 24px rgba(0, 0, 0, 0.3);
    border-color: rgba(102, 126, 234, 0.3);
  }

  .cover {
    aspect-ratio: 16/9;
    background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%);
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;
    overflow: hidden;
  }

  .cover::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(102, 126, 234, 0.1) 0%, rgba(118, 75, 162, 0.1) 100%);
    opacity: 0;
    transition: opacity 0.3s;
  }

  .game-card:hover .cover::before {
    opacity: 1;
  }

  .placeholder {
    font-size: 3rem;
    opacity: 0.4;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .info {
    padding: 1.25rem;
  }

  h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: #fff;
  }

  .saves {
    margin: 0;
    color: #999;
    font-size: 0.875rem;
  }

  .actions {
    padding: 0 1.25rem 1.25rem;
    display: flex;
    gap: 0.75rem;
  }

  .btn-play {
    flex: 1;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 0.875rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.9375rem;
    font-weight: 500;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .btn-play:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  }

  .btn-delete {
    background: rgba(68, 68, 68, 0.8);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 0.875rem 1rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.9375rem;
    transition: all 0.2s;
  }

  .btn-delete:hover {
    background: rgba(200, 50, 50, 0.8);
    border-color: rgba(200, 50, 50, 0.3);
  }
</style>
