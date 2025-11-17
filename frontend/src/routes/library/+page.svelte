<script lang="ts">
  import { onMount } from 'svelte';
  import { user, userLoading } from '$lib/stores/user';
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
    // Wait for auth check to complete
    const unsubscribe = userLoading.subscribe(async (loading) => {
      if (!loading) {
        if (!$user) {
          goto('/');
          return;
        }
        await loadGames();
        unsubscribe();
      }
    });
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

<nav class="menu">
  <div class="menu-content">
    <a href="/" class="logo">🎮 PSNES Online</a>
    <div class="menu-actions">
      <button on:click={() => showUpload = true} class="btn-upload">
        + Upload ROM
      </button>
      <button on:click={logout} class="btn-logout">
        Déconnexion
      </button>
    </div>
  </div>
</nav>

<div class="container">
  <div class="page-header">
    <div>
      <h1>Ma Bibliothèque</h1>
      <p class="subtitle">{$games.length} {$games.length === 1 ? 'jeu' : 'jeux'} dans votre collection</p>
    </div>
  </div>

  <div class="content">
    <div class="games-section">
      {#if $games.length === 0}
        <div class="empty-state">
          <div class="empty-icon">🎮</div>
          <h2>Votre bibliothèque est vide</h2>
          <p>Commencez par uploader votre première ROM SNES</p>
          <button on:click={() => showUpload = true} class="btn-upload-large">
            + Upload ROM
          </button>
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
  .menu {
    background: rgba(30, 30, 30, 0.95);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    padding: 1rem 2rem;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    backdrop-filter: blur(10px);
  }

  .menu-content {
    max-width: 1400px;
    margin: 0 auto;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .logo {
    font-size: 1.5rem;
    font-weight: 600;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-decoration: none;
    transition: opacity 0.2s;
  }

  .logo:hover {
    opacity: 0.8;
  }

  .menu-actions {
    display: flex;
    gap: 1rem;
  }

  .btn-upload {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    transition: transform 0.2s;
  }

  .btn-upload:hover {
    transform: translateY(-2px);
  }

  .btn-logout {
    background: #333;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    transition: background 0.2s;
  }

  .btn-logout:hover {
    background: #444;
  }

  .container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 2rem;
    padding-top: 6rem;
  }

  .page-header {
    margin-bottom: 3rem;
  }

  h1 {
    font-size: 2.5rem;
    margin: 0 0 0.5rem 0;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subtitle {
    font-size: 1.125rem;
    color: #888;
    margin: 0;
  }

  .content {
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: 2rem;
  }

  .games-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1.5rem;
  }

  .empty-state {
    text-align: center;
    padding: 6rem 2rem;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 16px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  .empty-icon {
    font-size: 4rem;
    margin-bottom: 1rem;
    opacity: 0.3;
  }

  .empty-state h2 {
    font-size: 1.75rem;
    margin: 0 0 0.75rem 0;
    color: #fff;
  }

  .empty-state p {
    font-size: 1.125rem;
    color: #888;
    margin: 0 0 2rem 0;
  }

  .btn-upload-large {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 1rem 2.5rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1.125rem;
    transition: transform 0.2s;
  }

  .btn-upload-large:hover {
    transform: translateY(-2px);
  }

  @media (max-width: 1024px) {
    .content {
      grid-template-columns: 1fr;
    }

    .page-header {
      margin-bottom: 2rem;
    }

    h1 {
      font-size: 2rem;
    }

    .games-grid {
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 1.5rem;
    }
  }
</style>
