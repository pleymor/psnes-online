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
    background: #2a2a2a;
    border-radius: 12px;
    overflow: hidden;
    transition: transform 0.2s;
  }

  .game-card:hover {
    transform: translateY(-4px);
  }

  .cover {
    aspect-ratio: 3/4;
    background: #1a1a1a;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .placeholder {
    font-size: 4rem;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .info {
    padding: 1rem;
  }

  h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.125rem;
  }

  .saves {
    margin: 0;
    color: #888;
    font-size: 0.875rem;
  }

  .actions {
    padding: 0 1rem 1rem;
    display: flex;
    gap: 0.5rem;
  }

  .btn-play {
    flex: 1;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .btn-delete {
    background: #444;
    color: white;
    border: none;
    padding: 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
  }
</style>
