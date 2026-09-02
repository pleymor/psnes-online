<script lang="ts">
  import { onMount } from 'svelte';
  import { user, userLoading } from '$lib/stores/user';
  import { games, loadGames } from '$lib/stores/games';
  import type { Game } from '$lib/stores/games';
  import { goto } from '$app/navigation';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { myRoom } from '$lib/rooms/my-room';
  import { gameClick } from '$lib/rooms/game-click';
  import { roomIntent } from '$lib/rooms/room-intent';
  import { deviceLibrary } from '$lib/roms/device-library';
  import { resolvableHere } from '$lib/roms/provider';
  import { syncFolder } from '$lib/roms/folder-sync';
  import {
    storedDirectory,
    ensureAccess,
    scanDirectory,
    registerGame,
    forgetIndexed,
    indexedChecksums
  } from '$lib/roms/local-library';
  import { pickerError } from '$lib/roms/picker-error';
  import {
    inviteToGroup,
    leaveGroup,
    chooseGameForGroup,
    launchSolo,
    openRoom,
    cancelGroupInvitation
  } from '$lib/rooms/actions';
  import GameCard from '$lib/components/GameCard.svelte';
  import GameDetailsModal from '$lib/components/GameDetailsModal.svelte';
  import LinkRom from '$lib/components/LinkRom.svelte';
  import IdentifyGame from '$lib/components/IdentifyGame.svelte';
  import LanguageSelector from '$lib/components/LanguageSelector.svelte';
  import TopBar from '$lib/components/TopBar.svelte';
  import { createLogger } from '$lib/utils/logger';
  import { setPageTitle } from '$lib/utils/page-title';

  const logger = createLogger('HomePage');

  // Two screens live at this address, and only one of them is the library.
  $: setPageTitle($language, $user ? t($language, 'library') : null);

  let selectedGame: Game | null = null;
  let gameToIdentify: Game | null = null;
  let showToast = false;
  let toastMessage = '';
  let toastType: 'success' | 'error' = 'success';
  let showDeleteConfirm = false;
  let gameToDelete: Game | null = null;

  /**
   * Les checksums que cet appareil sait ouvrir.
   *
   * `null` tant qu'on n'a pas regardé : afficher une bibliothèque vide pendant
   * la lecture d'IndexedDB ferait clignoter « aucun jeu » à chaque ouverture de
   * page, ce qui est exactement le mensonge inverse de celui qu'on corrige.
   */
  let resolvable: string[] | null = null;
  /**
   * Rejoué après chaque geste qui ajoute des octets à cet appareil.
   *
   * Réparer une entrée héritée garde son fichier, mais cette liste-ci a été
   * lue au montage : sans la relire, le jeu qu'on vient de réparer acquiert un
   * checksum qu'elle ignore et disparaît de la grille au moment précis où le
   * joueur a fait ce qu'on lui demandait.
   */
  async function refreshResolvable(): Promise<void> {
    resolvable = await resolvableHere();
  }
  onMount(refreshResolvable);

  /**
   * Le dossier de ROMs fait foi pour ce que cet appareil affiche.
   *
   * Le bouton n'existe que si un dossier est déjà mémorisé : sans dossier -
   * appareil neuf, ou Firefox et Safari qui n'ont pas `showDirectoryPicker` -
   * il n'aurait rien à rescanner, et le chemin pour en désigner un est le
   * panneau du profil, déjà atteignable depuis l'avatar et depuis l'appel à
   * l'action de la bibliothèque vide.
   */
  let folderKnown = false;
  let syncing = false;
  let syncProgress = '';
  let syncNote = '';

  onMount(async () => {
    // Une base indisponible (navigation privée, quota) ne doit pas casser le
    // montage de la page : pas de dossier connu, pas de bouton, c'est tout.
    folderKnown = !!(await storedDirectory().catch(() => undefined));
  });

  async function rescanFolder(): Promise<void> {
    syncing = true;
    syncNote = '';
    syncProgress = t($language, 'refreshingLibrary');
    try {
      const known = new Set(
        $games.map((g) => g.crc32).filter((c): c is string => !!c)
      );
      const handle = await storedDirectory();
      if (!handle || !(await ensureAccess(handle))) {
        // L'accès révoqué se re-demande depuis le profil, avec l'explication
        // qui va avec ; ici on ne peut que cesser de prétendre.
        folderKnown = !!handle;
        syncNote = t($language, 'romSource');
        return;
      }

      const result = await syncFolder({
        scan: () => scanDirectory(handle),
        register: registerGame,
        indexed: indexedChecksums,
        forget: forgetIndexed,
        // Le compte sait ce qu'il possède : sans ça, chaque clic renverrait
        // toute la logithèque au serveur et annoncerait des ajouts imaginaires.
        isKnown: (checksum) => known.has(checksum),
        onProgress: (done, total, filename) => {
          syncProgress = `${done}/${total} · ${filename}`;
        }
      });

      if (result.empty) {
        syncNote = t($language, 'noRomsFound');
        return;
      }

      // Les deux listes que la grille croise : ce que le compte possède, et ce
      // que cet appareil sait résoudre. Rafraîchir l'une sans l'autre laisse un
      // jeu ajouté invisible, ou un jeu retiré encore affiché.
      await loadGames();
      await refreshResolvable();

      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} ${t($language, 'gamesAdded')}`);
      if (result.removed > 0) parts.push(`${result.removed} ${t($language, 'gamesRemoved')}`);
      if (parts.length > 0) {
        syncNote = parts.join(' · ');
      } else if (result.failed > 0) {
        // Rien ajouté, rien retiré, mais des refus : cela ressemble trait pour
        // trait à un dossier déjà à jour, et c'est le contraire. Le seuil est
        // « au moins un refus », pas « tous » : huit fichiers déjà connus et
        // deux refusés ne font pas une bibliothèque à jour.
        syncNote = t($language, 'romsNoneAdded');
      } else {
        syncNote = t($language, 'libraryUpToDate');
      }
    } catch (err) {
      const message = pickerError(err);
      if (message) syncNote = message;
    } finally {
      syncing = false;
      syncProgress = '';
    }
  }

  /**
   * Ce que cet appareil peut réellement lancer.
   *
   * Le store `games` reste ce que le compte possède : le panneau ROM du profil
   * s'en sert pour dire combien de jeux ne sont pas ici.
   */
  $: shownGames = resolvable === null ? $games : deviceLibrary($games, resolvable);
  /*
   * The other member of my group, if there is one.
   *
   * `myRoom` is a store now, kept in step with the server: this page reads the
   * group's state continuously rather than once at mount, because a banner that
   * says who is here has to change when they arrive and when they leave.
   */
  $: myPartner = $myRoom?.players?.find((p) => p.userId !== $user?.id) ?? null;
  /** Two members: a group, rather than the leftover of one. */
  $: inGroup = ($myRoom?.players.length ?? 0) >= 2;
  $: groupBusy = $myRoom?.status === 'playing';

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
    await loadGames();
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

  /**
   * Where a click on a game goes.
   *
   * Three answers, and `gameClick` is what picks between them - this function
   * only carries out what was decided. Nothing navigates in the group branch:
   * `room:opened` comes back from the server and moves *both* players, which is
   * the whole point of choosing the game from here.
   *
   * `saveId` is the library's "resume from this save" path. Alone it rides in the
   * URL, as it always has; in a group it is staged through the server, because
   * in lockstep both machines have to boot from the same state.
   */
  function playGame(game: Game, saveId?: string) {
    // Without a checksum nobody - not even me - can find the file, so ask here
    // rather than let the game open onto an error.
    if (!game.crc32) {
      gameToLink = game;
      return;
    }

    const click = gameClick($myRoom);

    // The button is disabled in this state; this is the belt to that braces.
    if (click.kind === 'blocked') return;

    if (click.kind === 'choose-for-group') {
      chooseGameForGroup(click.roomId, { id: game.id, title: game.title }, saveId);
      return;
    }

    void launchSolo({ id: game.id, title: game.title }, saveId);
  }

  /*
   * Le bouton « Salon » : ouvrir un point de rendez-vous plutôt que lancer.
   *
   * `roomIntent` porte la décision, pour la même raison que `gameClick` porte
   * la sienne - trois branches, dont une que personne ne relit si elle vit
   * dans un template.
   */
  async function openRoomFor(game: Game) {
    const intent = roomIntent($myRoom);

    // Le bouton est désactivé dans cet état ; ceci est la bretelle à cette ceinture.
    if (intent.kind === 'blocked') return;

    if (intent.kind === 'reuse') {
      // Un salon existe déjà, et son lien est peut-être déjà parti : on y pose
      // ce jeu au lieu d'en abandonner un derrière soi.
      chooseGameForGroup(intent.roomId, { id: game.id, title: game.title });
      await goto(`/room/${intent.roomId}`);
      return;
    }

    await openRoom({ id: game.id, title: game.title });
  }

  // 'unknown' is both the starting point and the failure state. This used to
  // start at 'google' and stay there whenever /auth/mode did not answer, so a
  // backend that was simply down rendered a Google sign-in button - a dead end
  // locally, where the only way in is a dev profile, and one that blamed the
  // wrong thing: it read as "sign in with Google" when the truth was "no server".
  // A mode nobody told us is not a mode worth guessing.
  let authMode: 'google' | 'dev' | 'unknown' = 'unknown';
  let isLoadingAuthMode = true;

  async function loadAuthMode() {
    isLoadingAuthMode = true;
    try {
      const res = await fetch('/auth/mode', { credentials: 'include' });
      if (!res.ok) {
        logger.error('Failed to load auth mode: HTTP', res.status);
        authMode = 'unknown';
        return;
      }
      const data = await res.json();
      // An answer we cannot read leaves us as stuck as no answer at all.
      if (data.mode === 'dev' || data.mode === 'google') {
        authMode = data.mode;
      } else {
        logger.error('Unrecognised auth mode:', data.mode);
        authMode = 'unknown';
      }
    } catch (error) {
      logger.error('Failed to load auth mode:', error);
      authMode = 'unknown';
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
  <!-- Landing page for non-authenticated users.

       <main> rather than a <div>: this branch carries no TopBar, so nothing
       else on the screen is a landmark, and a screen reader had no "skip to
       the content" target at all. The signed-in branch below already has one.
       The class keeps the styling, so nothing moves. -->
  <main class="landing-container">
    <div class="hero">
      <h1>🎮 PSNES Online</h1>
      <p>{t($language, 'playWithFriends')}</p>

      <div class="login-section">
        <LanguageSelector />

        {#if isLoadingAuthMode}
          <div class="loading">{t($language, 'loading')}</div>
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
              <!-- Signs in with no chosen pseudonym, so the onboarding gate
                   comes up. Reset on every sign-in by the dev login route,
                   which is what makes it usable more than once. -->
              <button on:click={() => loginDev('3')} class="dev-user-btn">
                <span class="dev-user-avatar">🆕</span>
                <span class="dev-user-name">Dev User 3 (no nickname)</span>
              </button>
            </div>
          </div>
        {:else if authMode === 'google'}
          <button on:click={login} class="login-btn">
            {t($language, 'signInWithGoogle')}
          </button>
        {:else}
          <div class="auth-unavailable" role="alert">
            <p class="auth-unavailable-title">{t($language, 'authUnavailable')}</p>
            <p class="auth-unavailable-hint">{t($language, 'authUnavailableHint')}</p>
            <button on:click={loadAuthMode} class="login-btn">
              {t($language, 'retry')}
            </button>
          </div>
        {/if}
      </div>
    </div>
  </main>
{:else}
  <!-- Library page for authenticated users -->
  <div class="app-layout">
    <TopBar />

    <!-- Main Content -->
    <main class="main-content">
      <div class="page-header">
        <div>
          <h1>{t($language, 'library')}</h1>
          <p class="subtitle">{shownGames.length} {shownGames.length === 1 ? t($language, 'game') : t($language, 'games')}</p>
          {#if syncing && syncProgress}
            <p class="sync-note">{syncProgress}</p>
          {:else if syncNote}
            <p class="sync-note">{syncNote}</p>
          {/if}
        </div>
        {#if folderKnown}
          <button
            class="rescan"
            on:click={rescanFolder}
            disabled={syncing}
            title={t($language, 'refreshLibrary')}
          >
            <span class="rescan-icon" class:spinning={syncing} aria-hidden="true">⟳</span>
            <span class="rescan-label">{t($language, 'refreshLibrary')}</span>
          </button>
        {/if}
        <!-- The group's whole state in one strip: who is being waited on, who is
             here, and the way back into a game that is already running. It takes
             the place of the "create a room" button, which had nothing left to do
             once inviting a friend opened the room by itself. -->
        {#if $myRoom}
          <div class="group-strip">
            {#if $myRoom.invitation}
              <span class="group-who">
                {t($language, 'waitingForInvitee', { name: $myRoom.invitation.toPseudo })}
              </span>
              <button
                class="group-action"
                on:click={() => cancelGroupInvitation($myRoom?.invitation?.id ?? '')}
              >
                {t($language, 'cancelInvitation')}
              </button>
            {:else if groupBusy}
              <span class="group-who">
                {t($language, 'gameRunning')}{$myRoom.gameTitle ? ` — ${$myRoom.gameTitle}` : ''}
              </span>
            {:else if myPartner}
              <span class="group-who">{t($language, 'inGroupWith', { name: myPartner.pseudo })}</span>
              <span class="group-hint">{t($language, 'pickAGameTogether')}</span>
            {/if}

            {#if $myRoom.gameId || groupBusy}
              <button class="group-action" on:click={() => goto(`/room/${$myRoom?.id}`)}>
                {t($language, 'backToRoom')}
              </button>
            {/if}
            {#if !groupBusy}
              <button class="group-action" on:click={() => leaveGroup($myRoom?.id ?? '')}>
                {t($language, 'leaveGroup')}
              </button>
            {/if}
          </div>
        {/if}
      </div>

      <div class="content-wrapper">
        {#if shownGames.length === 0}
          <div class="empty-state">
            <div class="empty-icon">🎮</div>
            <!-- Deux vides différents, et les confondre serait le mensonge que
                 cet écran existe pour arrêter : « votre bibliothèque est vide »
                 dit à quelqu'un qui a deux cents jeux qu'il n'en a aucun. Ici on
                 nomme le compte, et le lien mène là où l'on désigne un
                 fichier. -->
            {#if $games.length > 0}
              <h2>{t($language, 'noneOnThisDevice', { count: $games.length })}</h2>
              <p>{t($language, 'noneOnThisDeviceHint')}</p>
            {:else}
              <h2>{t($language, 'emptyLibrary')}</h2>
              <p>{t($language, 'startUploading')}</p>
            {/if}
            <a class="empty-cta" href="/profile">{t($language, 'romSource')}</a>
          </div>
        {:else}
          <div class="games-grid">
            {#each shownGames as game}
              <GameCard
                {game}
                playDisabled={groupBusy}
                playLabel={inGroup && myPartner && !groupBusy
                  ? t($language, 'playWith', { name: myPartner.pseudo })
                  : t($language, 'play')}
                roomDisabled={groupBusy || roomIntent($myRoom).kind === 'blocked'}
                on:play={() => playGame(game)}
                on:room={() => openRoomFor(game)}
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
      on:linked={() => { gameToLink = null; loadGames(); refreshResolvable(); }}
    />
  {/if}

  {#if selectedGame}
    <!-- on:deleted: the grid drops the row itself, and this refreshes the
         library's own copy, which is what the modal reads from next time. -->
    <GameDetailsModal
      game={selectedGame}
      on:close={() => selectedGame = null}
      on:identify={() => { gameToIdentify = selectedGame; selectedGame = null; }}
      on:resume={(e) => { const g = selectedGame; selectedGame = null; if (g) playGame(g, e.detail); }}
      on:deleted={() => loadGames()}
    />
  {/if}

  {#if gameToIdentify}
    <IdentifyGame
      gameId={gameToIdentify.id}
      title={gameToIdentify.title}
      on:close={() => (gameToIdentify = null)}
      on:identified={() => { gameToIdentify = null; loadGames(); }}
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

  .auth-unavailable {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    align-items: center;
    width: 100%;
    max-width: 400px;
  }

  .auth-unavailable-title {
    font-size: 1rem;
    color: #ff5252;
    margin: 0;
    font-weight: 600;
  }

  .auth-unavailable-hint {
    font-size: 0.9375rem;
    color: #a0a0a0;
    margin: 0;
    line-height: 1.5;
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

  .group-strip {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding: 0.625rem 1rem;
    background: rgba(102, 126, 234, 0.12);
    border: 1px solid rgba(102, 126, 234, 0.35);
    border-radius: 10px;
  }

  .group-who {
    font-weight: 600;
    color: #fff;
  }

  .group-hint {
    color: #9aa0b5;
    font-size: 0.875rem;
  }

  .group-action {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.15);
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .group-action:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  /* Repris de .group-action, qui occupe le même bord du même en-tête : deux
     boutons voisins dessinés différemment se lisent comme deux natures. */
  .rescan {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.15);
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
    flex-shrink: 0;
  }

  .rescan:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.16);
  }

  .rescan:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .rescan-icon {
    display: inline-block;
    font-size: 1rem;
    line-height: 1;
  }

  .rescan-icon.spinning {
    animation: rescan-spin 1s linear infinite;
  }

  /* Un scan de quarante cartouches prend plusieurs secondes : sans ce signe,
     le joueur reclique. La requête de mouvement réduit coupe l'animation, pas
     le retour - le libellé et le compteur restent. */
  @keyframes rescan-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .rescan-icon.spinning { animation: none; }
  }

  .sync-note {
    margin: 0.25rem 0 0 0;
    font-size: 0.8125rem;
    color: rgba(255, 255, 255, 0.6);
  }

  /* Sous 480px l'en-tête passe en colonne : le libellé mangerait la largeur du
     titre, l'icône seule suffit puisque le title reste. */
  @media (max-width: 480px) {
    .rescan-label { display: none; }
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
