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
  import LinkRom from '$lib/components/LinkRom.svelte';
  import LanguageSelector from '$lib/components/LanguageSelector.svelte';
  import TopBar from '$lib/components/TopBar.svelte';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('HomePage');

  let selectedGame: Game | null = null;
  let showToast = false;
  let toastMessage = '';
  let toastType: 'success' | 'error' = 'success';
  let showDeleteConfirm = false;
  let gameToDelete: Game | null = null;
  let activeRooms: any[] = [];

  async function loadGames() {
    const res = await fetch('/api/games', { credentials: 'include' });
    if (res.ok) {
      const gamesData = await res.json();
      // Sort games alphabetically by title
      gamesData.sort((a: Game, b: Game) => a.title.localeCompare(b.title));
      games.set(gamesData);
    }
  }

  async function loadRooms() {
    try {
      const res = await fetch('/api/rooms', { credentials: 'include' });
      if (res.ok) {
        const rooms = await res.json();
        activeRooms = rooms;
        logger.debug('Active rooms:', activeRooms);
      }
    } catch (error) {
      logger.error('Failed to load rooms:', error);
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
      logger.error('Error deleting game:', error);
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

  async function loadUserData() {
    await Promise.all([loadGames(), loadRooms()]);
  }

  onMount(async () => {
    // Wait for auth check to complete
    const unsubscribe = userLoading.subscribe(async (loading) => {
      if (!loading) {
        if ($user) {
          await loadUserData();
        }
        unsubscribe();
      }
    });
  });

  /** A game from before local ROMs, waiting for the player to point at its file. */
  let gameToLink: Game | null = null;

  function createRoom(gameId: string, gameTitle: string) {
    // Without a checksum nobody - not even the host - can find the file, so
    // ask here rather than let the room open onto an error.
    const game = $games.find((g) => g.id === gameId);
    if (game && !game.crc32) {
      gameToLink = game;
      return;
    }

    // No cover in the payload: the server reads it from its own row for this
    // game and ignores anything we send, because a cover is rendered as an
    // image source and this side does not get to choose it.
    openRoom({ gameId, gameTitle, autoStart: false });
  }

  /**
   * A room with nobody's game in it yet.
   *
   * Distinct from the play button on a card, which is still the solo path: this
   * one opens a place to meet, and the game is chosen from inside it - by
   * either player, from their own library.
   */
  function createEmptyRoom() {
    openRoom({});
  }

  function openRoom(payload: { gameId?: string; gameTitle?: string; autoStart?: boolean }) {
    if (!$socket) return;

    $socket.emit('room:create', payload);

    // Wait for room created event
    $socket.once('room:created', (room: any) => {
      goto(`/room/${room.id}`);
    });
  }

  let authMode: 'google' | 'dev' = 'google';
  let isLoadingAuthMode = true;

  async function loadAuthMode() {
    try {
      const res = await fetch('/auth/mode', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        authMode = data.mode;
      }
    } catch (error) {
      logger.error('Failed to load auth mode:', error);
    } finally {
      isLoadingAuthMode = false;
    }
  }

  function login() {
    window.location.href = '/auth/google';
  }

  async function loginDev(userId: string) {
    try {
      const res = await fetch('/auth/dev/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId })
      });

      if (res.ok) {
        const userData = await res.json();
        user.set(userData);
        // onMount already ran (and unsubscribed) while logged out, so the
        // library/rooms/controls fetches have to be kicked off here — a
        // client-side goto('/') does not remount this page.
        await loadUserData();
        goto('/');
      } else {
        logger.error('Dev login failed');
      }
    } catch (error) {
      logger.error('Dev login error:', error);
    }
  }

  onMount(() => {
    loadAuthMode();
  });
</script>

{#if !$user}
  <!-- Landing page for non-authenticated users -->
  <div class="landing-container">
    <div class="hero">
      <h1>🎮 PSNES Online</h1>
      <p>{t($language, 'playWithFriends')}</p>

      <div class="login-section">
        <LanguageSelector />

        {#if isLoadingAuthMode}
          <div class="loading">Loading...</div>
        {:else if authMode === 'dev'}
          <div class="dev-login">
            <p class="dev-mode-label">🛠️ Development Mode</p>
            <div class="dev-users">
              <button on:click={() => loginDev('1')} class="dev-user-btn">
                <span class="dev-user-avatar">👤</span>
                <span class="dev-user-name">Dev User 1</span>
              </button>
              <button on:click={() => loginDev('2')} class="dev-user-btn">
                <span class="dev-user-avatar">🎮</span>
                <span class="dev-user-name">Dev User 2</span>
              </button>
            </div>
          </div>
        {:else}
          <button on:click={login} class="login-btn">
            {t($language, 'signInWithGoogle')}
          </button>
        {/if}
      </div>
    </div>
  </div>
{:else}
  <!-- Library page for authenticated users -->
  <div class="app-layout">
    <TopBar {activeRooms} />

    <!-- Main Content -->
    <main class="main-content">
      <div class="page-header">
        <div>
          <h1>{t($language, 'library')}</h1>
          <p class="subtitle">{$games.length} {$games.length === 1 ? t($language, 'game') : t($language, 'games')}</p>
        </div>
        <button class="btn-create-room" on:click={createEmptyRoom}>
          {t($language, 'createRoom')}
        </button>
      </div>

      <div class="content-wrapper">
        {#if $games.length === 0}
          <div class="empty-state">
            <div class="empty-icon">🎮</div>
            <h2>{t($language, 'emptyLibrary')}</h2>
            <p>{t($language, 'startUploading')}</p>
            <a class="empty-cta" href="/profile">{t($language, 'romSource')}</a>
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

  {#if gameToLink}
    <LinkRom
      gameId={gameToLink.id}
      title={gameToLink.title}
      on:close={() => (gameToLink = null)}
      on:linked={() => { gameToLink = null; loadGames(); }}
    />
  {/if}

  {#if selectedGame}
    <GameDetailsModal
      game={selectedGame}
      on:close={() => selectedGame = null}
    />
  {/if}

  {#if showDeleteConfirm && gameToDelete}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="modal-overlay" role="presentation" on:click={cancelDelete}>
      <div class="confirm-modal" role="alertdialog" aria-modal="true" on:click|stopPropagation>
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

  .login-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .loading {
    color: #888;
    font-size: 1rem;
  }

  .dev-login {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    align-items: center;
    width: 100%;
    max-width: 400px;
  }

  .dev-mode-label {
    font-size: 1rem;
    color: #ff9800;
    margin: 0;
    font-weight: 600;
  }

  .dev-users {
    display: flex;
    gap: 1rem;
    width: 100%;
  }

  .dev-user-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    background: rgba(42, 42, 42, 0.95);
    border: 2px solid rgba(102, 126, 234, 0.3);
    padding: 1.5rem 1rem;
    border-radius: 12px;
    cursor: pointer;
    transition: all 0.2s;
    color: white;
  }

  .dev-user-btn:hover {
    border-color: rgba(102, 126, 234, 0.8);
    background: rgba(102, 126, 234, 0.1);
    transform: translateY(-4px);
    box-shadow: 0 8px 16px rgba(102, 126, 234, 0.2);
  }

  .dev-user-avatar {
    font-size: 3rem;
    display: block;
  }

  .dev-user-name {
    font-size: 1rem;
    font-weight: 600;
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
    flex-direction: column;
    min-height: 100vh;
    background: #0a0a0a;
  }

  /* Main Content */
  .main-content {
    flex: 1;
    padding: 2rem;
  }

  .page-header {
    margin-bottom: 2rem;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .btn-create-room {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #fff;
    border: none;
    padding: 0.75rem 1.5rem;
    font-size: 1rem;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .btn-create-room:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
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
    max-width: 1400px;
    margin: 0 auto;
  }

  .games-grid {
    display: grid;
    /* Fixed 280px tracks, so auto-fill leaves a remainder at almost every
       window width. `start` pushed all of it to the right, which read as the
       whole library being pinned to the left edge; `center` splits it. The
       cards keep their size - only the block of tracks moves. */
    grid-template-columns: repeat(auto-fill, 280px);
    gap: 1.5rem;
    justify-content: center;
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

  .empty-cta {
    display: inline-block;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    text-decoration: none;
    padding: 1rem 2.5rem;
    border-radius: 8px;
    font-size: 1.125rem;
    transition: transform 0.2s;
  }

  .empty-cta:hover {
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

  @media (max-width: 768px) {
    .main-content {
      padding: 1rem;
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
