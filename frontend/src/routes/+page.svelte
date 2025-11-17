<script lang="ts">
  import { onMount } from 'svelte';
  import { user, userLoading } from '$lib/stores/user';
  import { games } from '$lib/stores/games';
  import type { Game } from '$lib/stores/games';
  import { socket } from '$lib/api/socket';
  import { goto } from '$app/navigation';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import GameCard from '$lib/components/GameCard.svelte';
  import GameDetailsModal from '$lib/components/GameDetailsModal.svelte';
  import UploadGame from '$lib/components/UploadGame.svelte';
  import FriendsList from '$lib/components/FriendsList.svelte';
  import ControlsModal from '$lib/components/ControlsModal.svelte';
  import LanguageSelector from '$lib/components/LanguageSelector.svelte';
  import type { KeyConfig } from '$lib/types';

  // Accept params prop from SvelteKit (unused but prevents warnings)
  export let params = {};

  let showUpload = false;
  let selectedGame: Game | null = null;
  let isRefreshingMetadata = false;
  let showToast = false;
  let toastMessage = '';
  let toastType: 'success' | 'error' = 'success';
  let showDeleteConfirm = false;
  let gameToDelete: Game | null = null;
  let showControls = false;
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

  async function loadGames() {
    const res = await fetch('/api/games', { credentials: 'include' });
    if (res.ok) {
      const gamesData = await res.json();
      games.set(gamesData);
    }
  }

  async function loadUserControls() {
    try {
      const res = await fetch('/api/user/controls', { credentials: 'include' });
      if (res.ok) {
        const config = await res.json();
        userKeyConfig = config;
      }
    } catch (error) {
      console.error('Failed to load user controls:', error);
    }
  }

  function handleDeleteRequest(game: Game) {
    gameToDelete = game;
    showDeleteConfirm = true;
  }

  async function confirmDelete() {
    if (!gameToDelete) return;

    try {
      const res = await fetch(`/api/games/${gameToDelete.id}`, {
        method: 'DELETE',
        credentials: 'include'
      });

      if (res.ok) {
        showNotification(`"${gameToDelete.title}" deleted successfully`, 'success');
        await loadGames();
      } else {
        showNotification('Failed to delete game', 'error');
      }
    } catch (error) {
      console.error('Error deleting game:', error);
      showNotification('Error deleting game', 'error');
    } finally {
      showDeleteConfirm = false;
      gameToDelete = null;
    }
  }

  function cancelDelete() {
    showDeleteConfirm = false;
    gameToDelete = null;
  }

  function showNotification(message: string, type: 'success' | 'error' = 'success') {
    toastMessage = message;
    toastType = type;
    showToast = true;
    setTimeout(() => {
      showToast = false;
    }, 4000);
  }

  async function refreshMetadata() {
    isRefreshingMetadata = true;

    try {
      const res = await fetch('/api/games/refresh-metadata', {
        method: 'POST',
        credentials: 'include'
      });

      if (res.ok) {
        const result = await res.json();
        await loadGames();
        showNotification(
          `Metadata updated! ${result.updated} game${result.updated !== 1 ? 's' : ''} matched, ${result.skipped} skipped.`,
          'success'
        );
      } else {
        showNotification('Failed to refresh metadata', 'error');
      }
    } catch (error) {
      console.error('Error refreshing metadata:', error);
      showNotification('Error refreshing metadata', 'error');
    } finally {
      isRefreshingMetadata = false;
    }
  }

  onMount(async () => {
    // Wait for auth check to complete
    const unsubscribe = userLoading.subscribe(async (loading) => {
      if (!loading) {
        if ($user) {
          await Promise.all([loadGames(), loadUserControls()]);
        }
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

  function login() {
    window.location.href = '/auth/google';
  }

  async function logout() {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'include'
    });
    user.set(null);
    goto('/');
  }

  function handleControlsSaved(event: CustomEvent<{ config: any }>) {
    userKeyConfig = { ...event.detail.config };
  }
</script>

{#if !$user}
  <!-- Landing page for non-authenticated users -->
  <div class="landing-container">
    <div class="hero">
      <h1>🎮 PSNES Online</h1>
      <p>{t($language, 'playWithFriends')}</p>

      <div class="legal-disclaimer">
        <p><strong>⚠️ {t($language, 'legalWarning')}</strong></p>
        <p>{t($language, 'legalText')}</p>
      </div>

      <div class="login-section">
        <LanguageSelector />
        <button on:click={login} class="login-btn">
          {t($language, 'signInWithGoogle')}
        </button>
      </div>
    </div>
  </div>
{:else}
  <!-- Library page for authenticated users -->
  <div class="app-layout">
    <!-- Sidebar Menu -->
    <aside class="sidebar-menu">
      <div class="sidebar-header">
        <a href="/" class="logo">🎮 PSNES</a>
      </div>

      <nav class="sidebar-nav">
        <div class="nav-section">
          <LanguageSelector />
        </div>

        <div class="nav-section">
          <button on:click={() => showUpload = true} class="nav-button nav-button-primary">
            <span class="icon">+</span>
            <span class="label">{t($language, 'uploadROM')}</span>
          </button>

          <button on:click={() => showControls = true} class="nav-button">
            <span class="icon">🎮</span>
            <span class="label">{t($language, 'controls')}</span>
          </button>

          <button on:click={refreshMetadata} class="nav-button" disabled={isRefreshingMetadata}>
            <span class="icon">{isRefreshingMetadata ? '⏳' : '🔄'}</span>
            <span class="label">{isRefreshingMetadata ? 'Updating...' : 'Update Metadata'}</span>
          </button>
        </div>

        <div class="nav-section nav-section-friends">
          <FriendsList />
        </div>

        <div class="nav-section nav-section-bottom">
          <button on:click={logout} class="nav-button nav-button-logout">
            <span class="icon">🚪</span>
            <span class="label">{t($language, 'logout')}</span>
          </button>
        </div>
      </nav>
    </aside>

    <!-- Main Content -->
    <main class="main-content">
      <div class="page-header">
        <div>
          <h1>{t($language, 'library')}</h1>
          <p class="subtitle">{$games.length} {$games.length === 1 ? 'game' : 'games'}</p>
        </div>
      </div>

      <div class="content-wrapper">
        {#if $games.length === 0}
          <div class="empty-state">
            <div class="empty-icon">🎮</div>
            <h2>Your library is empty</h2>
            <p>Start by uploading your first SNES ROM</p>
            <button on:click={() => showUpload = true} class="btn-upload-large">
              + {t($language, 'uploadROM')}
            </button>
          </div>
        {:else}
          <div class="games-grid">
            {#each $games as game}
              <GameCard
                {game}
                on:play={() => createRoom(game.id, game.title)}
                on:details={() => selectedGame = game}
                on:delete={() => handleDeleteRequest(game)}
              />
            {/each}
          </div>
        {/if}
      </div>
    </main>
  </div>

  {#if showUpload}
    <UploadGame
      on:close={() => showUpload = false}
      on:uploaded={() => { showUpload = false; loadGames(); }}
    />
  {/if}

  {#if selectedGame}
    <GameDetailsModal
      game={selectedGame}
      on:close={() => selectedGame = null}
    />
  {/if}

  {#if showDeleteConfirm && gameToDelete}
    <div class="modal-overlay" on:click={cancelDelete}>
      <div class="confirm-modal" on:click|stopPropagation>
        <h3>Delete Game?</h3>
        <p>Are you sure you want to delete "{gameToDelete.title}"?</p>
        <p class="warning">This action cannot be undone.</p>
        <div class="modal-actions">
          <button on:click={cancelDelete} class="btn-cancel">Cancel</button>
          <button on:click={confirmDelete} class="btn-confirm-delete">Delete</button>
        </div>
      </div>
    </div>
  {/if}

  <ControlsModal
    bind:show={showControls}
    currentConfig={userKeyConfig}
    on:close={() => showControls = false}
    on:saved={handleControlsSaved}
  />

  {#if showToast}
    <div class="toast toast-{toastType}">
      <div class="toast-content">
        <span class="toast-icon">{toastType === 'success' ? '✅' : '❌'}</span>
        <span class="toast-message">{toastMessage}</span>
      </div>
    </div>
  {/if}
{/if}

<style>
  /* Landing page styles */
  .landing-container {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    padding: 2rem;
  }

  .hero {
    text-align: center;
    max-width: 600px;
  }

  .hero h1 {
    font-size: 3rem;
    margin-bottom: 1rem;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .hero p {
    font-size: 1.25rem;
    color: #a0a0a0;
    margin-bottom: 2rem;
  }

  .legal-disclaimer {
    background: rgba(255, 152, 0, 0.1);
    border: 1px solid rgba(255, 152, 0, 0.3);
    border-radius: 8px;
    padding: 1.25rem;
    margin: 2rem 0;
    max-width: 700px;
  }

  .legal-disclaimer p {
    font-size: 0.875rem;
    color: #ddd;
    margin-bottom: 0.75rem;
    line-height: 1.6;
  }

  .legal-disclaimer p:first-child {
    text-align: center;
    font-size: 1rem;
  }

  .legal-disclaimer p:last-child {
    margin-bottom: 0;
  }

  .legal-disclaimer strong {
    color: #ff9800;
    font-size: 1rem;
  }

  .login-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .login-btn {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 1rem 2rem;
    font-size: 1.125rem;
    border-radius: 8px;
    cursor: pointer;
    transition: transform 0.2s;
  }

  .login-btn:hover {
    transform: translateY(-2px);
  }

  /* Library page styles */
  .app-layout {
    display: flex;
    min-height: 100vh;
    background: #0a0a0a;
  }

  /* Sidebar Menu */
  .sidebar-menu {
    width: 340px;
    background: rgba(20, 20, 20, 0.95);
    border-right: 1px solid rgba(255, 255, 255, 0.1);
    display: flex;
    flex-direction: column;
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 1000;
    backdrop-filter: blur(10px);
    overflow-y: auto;
  }

  .sidebar-header {
    padding: 2rem 1.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .logo {
    font-size: 1.5rem;
    font-weight: 700;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-decoration: none;
    display: block;
    transition: opacity 0.2s;
  }

  .logo:hover {
    opacity: 0.8;
  }

  .sidebar-nav {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 1rem 0;
  }

  .nav-section {
    padding: 0.5rem 1rem;
    margin-bottom: 1rem;
  }

  .nav-section-friends {
    flex: 1;
    overflow-y: auto;
    padding: 0;
    margin-bottom: 0;
  }

  .nav-section-bottom {
    margin-top: 0;
    margin-bottom: 0;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    padding-top: 1rem;
  }

  .nav-button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: #ccc;
    cursor: pointer;
    transition: all 0.2s;
    font-size: 0.95rem;
    margin-bottom: 0.5rem;
  }

  .nav-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.05);
    color: white;
    transform: translateX(4px);
  }

  .nav-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .nav-button .icon {
    font-size: 1.25rem;
    width: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .nav-button .label {
    flex: 1;
    text-align: left;
  }

  .nav-button-primary {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
  }

  .nav-button-primary:hover {
    background: linear-gradient(135deg, #7d8ef5 0%, #8a5bb8 100%);
    transform: translateX(4px);
  }

  .nav-button-logout {
    color: #f44336;
  }

  .nav-button-logout:hover {
    background: rgba(244, 67, 54, 0.1);
    color: #f44336;
  }

  /* Main Content */
  .main-content {
    flex: 1;
    margin-left: 340px;
    padding: 2rem;
  }

  .page-header {
    margin-bottom: 2rem;
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

  .content-wrapper {
    width: 100%;
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

  .toast {
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    background: rgba(42, 42, 42, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 1rem 1.5rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    z-index: 3000;
    backdrop-filter: blur(10px);
    animation: slideInUp 0.3s ease-out;
  }

  @keyframes slideInUp {
    from {
      transform: translateY(100px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .toast-success {
    border-left: 4px solid #4caf50;
  }

  .toast-error {
    border-left: 4px solid #f44336;
  }

  .toast-content {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .toast-icon {
    font-size: 1.5rem;
  }

  .toast-message {
    color: #fff;
    font-size: 1rem;
    font-weight: 500;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2000;
    animation: fadeIn 0.2s ease-out;
  }

  .confirm-modal {
    background: linear-gradient(135deg, #1e1e1e 0%, #2a2a2a 100%);
    border-radius: 16px;
    padding: 2rem;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.1);
    animation: slideUp 0.3s ease-out;
  }

  .confirm-modal h3 {
    margin: 0 0 1rem 0;
    font-size: 1.5rem;
    color: #fff;
  }

  .confirm-modal p {
    margin: 0 0 0.5rem 0;
    color: #ccc;
    font-size: 1rem;
    line-height: 1.5;
  }

  .confirm-modal .warning {
    color: #f44336;
    font-size: 0.875rem;
    margin-bottom: 1.5rem;
  }

  .modal-actions {
    display: flex;
    gap: 1rem;
    justify-content: flex-end;
  }

  .btn-cancel {
    background: rgba(68, 68, 68, 0.8);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    transition: all 0.2s;
  }

  .btn-cancel:hover {
    background: rgba(88, 88, 88, 0.8);
  }

  .btn-confirm-delete {
    background: linear-gradient(135deg, #f44336 0%, #d32f2f 100%);
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    transition: all 0.2s;
  }

  .btn-confirm-delete:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(244, 67, 54, 0.4);
  }

  @media (max-width: 1200px) {
    .sidebar-menu {
      width: 280px;
    }

    .main-content {
      margin-left: 280px;
    }

    .games-grid {
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 1.5rem;
    }
  }

  @media (max-width: 1024px) {
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

    .toast {
      left: 1rem;
      right: 1rem;
      bottom: 1rem;
    }
  }

  @media (max-width: 768px) {
    .sidebar-menu {
      width: 70px;
    }

    .sidebar-header {
      padding: 1.5rem 0.5rem;
    }

    .logo {
      font-size: 1.25rem;
      text-align: center;
    }

    .nav-section {
      padding: 0.5rem 0.5rem;
    }

    .nav-section-friends {
      display: none;
    }

    .nav-button .label {
      display: none;
    }

    .nav-button {
      justify-content: center;
      padding: 0.875rem 0.5rem;
    }

    .nav-button .icon {
      margin: 0;
    }

    .main-content {
      margin-left: 70px;
      padding: 1rem;
    }

    .games-grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 1rem;
    }
  }
</style>
