<script lang="ts">
  import { onMount } from 'svelte';
  import { user } from '$lib/stores/user';
  import { games } from '$lib/stores/games';
  import { socket } from '$lib/api/socket';
  import { goto } from '$app/navigation';
  import GameCard from '$lib/components/GameCard.svelte';
  import UploadGame from '$lib/components/UploadGame.svelte';
  import FriendsList from '$lib/components/FriendsList.svelte';

  let showUpload = false;

  async function loadGames() {
    const res = await fetch('/api/games', { credentials: 'include' });
    if (res.ok) {
      const gamesData = await res.json();
      games.set(gamesData);
    }
  }

  onMount(async () => {
    if (!$user) {
      goto('/');
      return;
    }

    await loadGames();
  });

  async function createRoom(gameId: string, gameTitle: string) {
    if ($socket) {
      $socket.emit('room:create', { gameId, gameTitle });

      // Wait for room created event
      $socket.once('room:created', (room: any) => {
        goto(`/room/${room.id}`);
      });
    }
  }

  async function logout() {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include'
    });
    user.set(null);
    goto('/');
  }
</script>

<div class="container">
  <header>
    <h1>My Game Library</h1>
    <div class="actions">
      <button on:click={() => showUpload = true} class="btn-primary">
        + Upload ROM
      </button>
      <button on:click={logout} class="btn-secondary">
        Logout
      </button>
    </div>
  </header>

  <div class="content">
    <div class="games-section">
      {#if $games.length === 0}
        <div class="empty-state">
          <p>No games in your library yet.</p>
          <button on:click={() => showUpload = true}>Upload your first ROM</button>
        </div>
      {:else}
        <div class="games-grid">
          {#each $games as game}
            <GameCard {game} on:play={() => createRoom(game.id, game.title)} />
          {/each}
        </div>
      {/if}
    </div>

    <aside class="sidebar">
      <FriendsList />
    </aside>
  </div>
</div>

{#if showUpload}
  <UploadGame
    on:close={() => showUpload = false}
    on:uploaded={() => { showUpload = false; loadGames(); }}
  />
{/if}

<style>
  .container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 2rem;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 2rem;
  }

  h1 {
    font-size: 2rem;
    margin: 0;
  }

  .actions {
    display: flex;
    gap: 1rem;
  }

  .content {
    display: grid;
    grid-template-columns: 1fr 300px;
    gap: 2rem;
  }

  .games-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1.5rem;
  }

  .empty-state {
    text-align: center;
    padding: 4rem 2rem;
    color: #666;
  }

  .btn-primary {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
  }

  .btn-secondary {
    background: #333;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
  }

  @media (max-width: 1024px) {
    .content {
      grid-template-columns: 1fr;
    }
  }
</style>
