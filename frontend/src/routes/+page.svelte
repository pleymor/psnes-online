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
  import FriendDetailsModal from '$lib/components/FriendDetailsModal.svelte';
  import ControlsModal from '$lib/components/ControlsModal.svelte';
  import LanguageSelector from '$lib/components/LanguageSelector.svelte';
  import type { KeyConfig } from '$lib/types';

  // Accept params prop from SvelteKit (unused but prevents warnings)
  export let params = {};

  let showUpload = false;
  let selectedGame: Game | null = null;
  let selectedFriend: any = null;
  let friendsListRef: FriendsList;
  let isRefreshingMetadata = false;
  let showToast = false;
  let toastMessage = '';
  let toastType: 'success' | 'error' = 'success';
  let showDeleteConfirm = false;
  let gameToDelete: Game | null = null;
  let showControls = false;
  let showMobileSidebar = false;
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
      // Sort games alphabetically by title
      gamesData.sort((a: Game, b: Game) => a.title.localeCompare(b.title));
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
        showNotification(t($language, 'gameDeleted', { title: gameToDelete.title }), 'success');
        await loadGames();
      } else {
        showNotification(t($language, 'failedToDeleteGame'), 'error');
      }
    } catch (error) {
      console.error('Error deleting game:', error);
      showNotification(t($language, 'errorDeletingGame'), 'error');
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

  function handleFriendClicked(event: CustomEvent<any>) {
    selectedFriend = event.detail;
  }

  async function handleRemoveFriend(event: CustomEvent<{ friendshipId: string }>) {
    const { friendshipId } = event.detail;

    if (friendsListRef) {
      await friendsListRef.removeFriend(friendshipId);
      selectedFriend = null;
    }
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
          t($language, 'metadataUpdated', { updated: result.updated, skipped: result.skipped }),
          'success'
        );
      } else {
        showNotification(t($language, 'failedToRefreshMetadata'), 'error');
      }
    } catch (error) {
      console.error('Error refreshing metadata:', error);
      showNotification(t($language, 'errorRefreshingMetadata'), 'error');
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
    // Setting user to null will trigger socket cleanup in layout
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
    <!-- Mobile burger button -->
    <button class="burger-btn" on:click={() => showMobileSidebar = !showMobileSidebar}>
      <span></span>
      <span></span>
      <span></span>
    </button>

    <!-- Mobile overlay -->
    {#if showMobileSidebar}
      <div class="mobile-overlay" on:click={() => showMobileSidebar = false}></div>
    {/if}

    <!-- Sidebar Menu -->
    <aside class="sidebar-menu" class:show-mobile={showMobileSidebar}>
      <div class="sidebar-header">
        <a href="/" class="logo">🎮 PSNES</a>
        <LanguageSelector />
      </div>

      <nav class="sidebar-nav">
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
            <span class="label">{isRefreshingMetadata ? t($language, 'updating') : t($language, 'updateMetadata')}</span>
          </button>
        </div>

        <div class="nav-section nav-section-friends">
          <FriendsList bind:this={friendsListRef} on:friendClicked={handleFriendClicked} />
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
          <p class="subtitle">{$games.length} {$games.length === 1 ? t($language, 'game') : t($language, 'games')}</p>
        </div>
      </div>

      <div class="content-wrapper">
        {#if $games.length === 0}
          <div class="empty-state">
            <div class="empty-icon">🎮</div>
            <h2>{t($language, 'emptyLibrary')}</h2>
            <p>{t($language, 'startUploading')}</p>
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

  {#if selectedFriend}
    <FriendDetailsModal
      friend={selectedFriend.friend}
      friendsSince={selectedFriend.friendsSince}
      friendshipId={selectedFriend.friendshipId}
      on:close={() => selectedFriend = null}
      on:remove={handleRemoveFriend}
    />
  {/if}

  {#if showDeleteConfirm && gameToDelete}
    <div class="modal-overlay" on:click={cancelDelete}>
      <div class="confirm-modal" on:click|stopPropagation>
        <h3>{t($language, 'deleteGame')}</h3>
        <p>{t($language, 'confirmDeleteGame', { title: gameToDelete.title })}</p>
        <p class="warning">{t($language, 'actionCannotBeUndone')}</p>
        <div class="modal-actions">
          <button on:click={cancelDelete} class="btn-cancel">{t($language, 'cancel')}</button>
          <button on:click={confirmDelete} class="btn-confirm-delete">{t($language, 'delete')}</button>
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .logo {
    font-size: 1.5rem;
    font-weight: 700;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    text-decoration: none;
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

  .nav-section-friends-compact {
    display: none;
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
    grid-template-columns: repeat(auto-fill, 280px);
    gap: 1.5rem;
    justify-content: start;
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

  /* Burger menu button */
  .burger-btn {
    display: none;
    position: fixed;
    top: 1rem;
    left: 1rem;
    z-index: 10001;
    background: rgba(42, 42, 42, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    width: 48px;
    height: 48px;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    backdrop-filter: blur(10px);
    transition: all 0.3s;
  }

  .burger-btn:hover {
    background: rgba(102, 126, 234, 0.2);
    border-color: rgba(102, 126, 234, 0.5);
  }

  .burger-btn span {
    display: block;
    width: 24px;
    height: 2px;
    background: white;
    border-radius: 2px;
    transition: all 0.3s;
  }

  /* Mobile overlay */
  .mobile-overlay {
    display: none;
  }

  @media (max-width: 768px) {
    .burger-btn {
      display: flex;
    }

    .mobile-overlay {
      display: block;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 9998;
      backdrop-filter: blur(4px);
    }

    .sidebar-menu {
      position: fixed;
      left: -340px;
      transition: left 0.3s ease-in-out;
      z-index: 9999;
    }

    .sidebar-menu.show-mobile {
      left: 0;
    }

    .main-content {
      margin-left: 0;
      padding: 1rem;
      padding-top: 4rem;
    }

    .games-grid {
      grid-template-columns: 1fr;
      gap: 1rem;
    }

    .toast {
      left: 1rem;
      right: 1rem;
      bottom: 1rem;
    }
  }
</style>
