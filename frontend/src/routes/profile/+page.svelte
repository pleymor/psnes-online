<script lang="ts">
  /**
   * Everything the sidebar used to hold that was not navigation.
   *
   * A route rather than a modal: it carries enough to deserve an address, and
   * an address can be shared, opened in a tab, and left with the back button.
   *
   * Sections are ordered by what someone came for - identity first, settings
   * next, signing out last because it is the destructive one.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { user, userLoading } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t, type TranslationKey } from '$lib/i18n/translations';
  import { normaliseControlsConfig, type ControlsConfig } from '$lib/controls/binding';
  import TopBar from '$lib/components/TopBar.svelte';
  import ControlsSettings from '$lib/components/ControlsSettings.svelte';
  import { watchPads } from '$lib/controls/pad-watch';
  import LanguageSelector from '$lib/components/LanguageSelector.svelte';
  import RomSourcePanel from '$lib/components/RomSourcePanel.svelte';
  import { SHADERS } from '$lib/shaders';
  import { readShaderPreference, writeShaderPreference } from '$lib/stores/shader-preference';
  import {
    MAX_CONFIG_BYTES,
    applyConfig,
    configFileName,
    gatherConfig,
    readConfigFile,
    serialiseConfig,
    type ImportNotice,
    type ImportRefusal
  } from '$lib/config/portable-config';
  import { romFileProblem, ACCEPT } from '$lib/roms/rom-file';
  import { registerGame } from '$lib/roms/local-library';
  import { setPageTitle } from '$lib/utils/page-title';
  import { createLogger } from '$lib/utils/logger';
  import { formatHandle, isValidPseudo, PSEUDO_MIN, PSEUDO_MAX } from '$lib/pseudo';
  import { games, loadGames } from '$lib/stores/games';
  import { deviceLibrary } from '$lib/roms/device-library';
  import { designateFile, resolvableHere } from '$lib/roms/provider';

  const logger = createLogger('ProfilePage');

  $: setPageTitle($language, t($language, 'profile'));

  // The bar is the same one the library page shows, so the page keeps its
  // chrome instead of stranding the user with a lone back link. It needs the
  // active rooms for the friends drawer's join buttons.
  let controlsConfig: ControlsConfig | null = null;
  let controlsError = '';
  let shader = '';
  let refreshing = false;
  let refreshMessage = '';
  let configBusy = false;
  let configMessage = '';
  let configError = '';
  let configNotices: ImportNotice[] = [];
  let loggingOut = false;
  let logoutMessage = '';

  let pseudoDraft = '';
  let renaming = false;
  let renameError = '';
  let copied = false;

  let resolvable: string[] | null = null;
  async function refreshResolvable(): Promise<void> {
    resolvable = await resolvableHere();
  }
  onMount(refreshResolvable);

  // Le store `games` n'est rempli que par l'accueil et par une room. Arriver
  // ici par un rechargement, un favori ou un onglet neuf le laissait vide, donc
  // `missingCount` à zéro, donc la ligne muette - dans le cas précis où un
  // joueur perplexe recharge la page pour regarder à nouveau. C'est la seule
  // compensation au masquage des jeux : elle doit tenir hors navigation client.
  onMount(loadGames);
  // Zéro tant qu'on n'a pas regardé : annoncer « 200 jeux absents » pendant la
  // lecture d'IndexedDB serait alarmant et faux.
  $: missingCount =
    resolvable === null ? 0 : $games.length - deviceLibrary($games, resolvable).length;

  // Seeded from the store, and re-seeded whenever the store changes - after a
  // successful rename, most of all, so the field agrees with the heading above
  // it rather than keeping the text that was submitted.
  $: pseudoDraft = $user?.pseudo ?? '';
  $: handle = $user ? formatHandle($user.pseudo, $user.discriminator) : '';
  $: pseudoMalformed = pseudoDraft.length > 0 && !isValidPseudo(pseudoDraft);
  $: canRename = isValidPseudo(pseudoDraft) && pseudoDraft !== $user?.pseudo && !renaming;

  async function copyHandle(): Promise<void> {
    try {
      await navigator.clipboard.writeText(handle);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch (err) {
      // A refused clipboard is not worth an error banner: the code is on
      // screen and can be read out.
      logger.error('Could not copy the handle', err);
    }
  }

  /**
   * The same endpoint the onboarding modal uses, deliberately: claiming a
   * pseudonym for the first time and changing it later are the same operation,
   * and two routes doing it would drift apart on validation.
   */
  async function renamePseudo(): Promise<void> {
    if (!canRename) return;

    renaming = true;
    renameError = '';
    try {
      const res = await fetch('/api/pseudo', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pseudo: pseudoDraft })
      });

      if (res.ok) {
        const next = await res.json();
        user.update(current => current && { ...current, ...next });
        return;
      }

      const body = await res.json().catch(() => ({}));
      renameError = body.error === 'PSEUDO_FULL'
        ? t($language, 'pseudoFull')
        : body.error === 'PSEUDO_INVALID'
        ? t($language, 'pseudoRules', { min: PSEUDO_MIN, max: PSEUDO_MAX })
        : t($language, 'pseudoFailed');
    } catch (err) {
      logger.error('Could not change the pseudonym', err);
      renameError = t($language, 'pseudoFailed');
    } finally {
      renaming = false;
    }
  }

  let fileInput: HTMLInputElement;
  let romBusy = false;
  let romError = '';
  let romProgress = '';
  let romAdded = false;

  async function onFileChosen(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;

    const problem = romFileProblem(file.name, file.size);
    if (problem) {
      romError = t($language, problem);
      return;
    }

    romBusy = true;
    romError = '';
    romAdded = false;
    try {
      romProgress = file.name;
      // Désigner d'abord, enregistrer ensuite : c'est ici, et non dans
      // `registerGame`, que cet appareil acquiert les octets. Sur un navigateur
      // sans sélecteur de dossier ce bouton est le seul moyen d'ajouter un jeu,
      // et n'enregistrer que l'identité laissait une bibliothèque définitivement
      // vide - le jeu ajouté n'était résoluble nulle part.
      const { checksum } = await designateFile(file);
      await registerGame(checksum, file.name);
      romAdded = true;
      // La grille et la ligne « N jeux ne sont pas sur cet appareil » lisent
      // deux listes montées une fois ; sans ces deux relectures le jeu qu'on
      // vient d'ajouter reste invisible jusqu'au prochain rechargement.
      await Promise.all([loadGames(), refreshResolvable()]);
    } catch (err) {
      romError = err instanceof Error ? err.message : String(err);
      logger.error('Could not add the game', err);
    } finally {
      romBusy = false;
      romProgress = '';
    }
  }

  onMount(() => {
    // $user is null both while signed out and while the root layout's auth
    // check is still in flight, so bouncing on a bare `!$user` would also
    // bounce every legitimate visitor on first load. userLoading is the
    // signal that the session answer has arrived; only then is a null
    // $user proof of being signed out.
    // Unsubscribing from inside the subscriber would be a reference to a
    // `const` that is not initialised yet: when the store has already
    // settled - every client-side navigation here, i.e. clicking the avatar -
    // the callback runs synchronously during subscribe(). A flag settles it
    // once and onDestroy does the unsubscribing.
    let settled = false;
    const stop = userLoading.subscribe((loading) => {
      if (loading || settled) return;
      settled = true;
      if (!$user) void goto('/');
    });
    return stop;
  });

  /*
   * The search for a controller starts with the page, not with the card.
   *
   * The controls card waits for `/api/user/controls` before it renders anything,
   * and a browser only admits a gamepad exists once one of its buttons has been
   * pressed - so a press during that round trip used to be missed entirely, and
   * the panel came up saying there was no controller. Watching from here means
   * the press is caught whenever it lands. Two watchers share one timer, so the
   * card starting its own costs nothing.
   */
  onMount(() => watchPads());

  onMount(async () => {
    // localStorage owns the display setting; this page and the pause menu both
    // read it at mount and write it on change. They never coexist on screen,
    // so there is nothing to keep in sync.
    shader = readShaderPreference(localStorage);

    try {
      const res = await fetch('/api/user/controls', { credentials: 'include' });
      // Showing nothing on failure is deliberate: presenting stale or absent
      // key bindings as if they were the saved config would be worse than an
      // explanation and an empty section.
      if (res.ok) controlsConfig = normaliseControlsConfig(await res.json());
      else controlsError = t($language, 'controlsLoadFailed');
    } catch {
      controlsError = t($language, 'controlsLoadFailed');
    }

  });

  function chooseShader(id: string): void {
    shader = id;
    writeShaderPreference(localStorage, id);
  }

  /*
   * Carrying a configuration to another machine.
   *
   * Deliberately not a backup: a backup server already stands between anyone
   * and losing data, and calling this one would invite a player to treat a file
   * in their downloads folder as a safety net. What it is for is the second
   * machine, and the second account - rebinding twelve buttons by hand twice is
   * the thing worth removing.
   *
   * The file is its own, not the same envelope as the saves export: it is small
   * enough that a player can open it and check for themselves that it holds no
   * account of theirs, which an archive of opaque save blobs never will be.
   */
  const REFUSALS: Record<ImportRefusal, TranslationKey> = {
    notJson: 'configNotJson',
    notAConfigFile: 'configNotAConfigFile',
    fromANewerBuild: 'configFromANewerBuild',
    tooLarge: 'configTooLarge'
  };

  const NOTICES: Record<ImportNotice, TranslationKey> = {
    controlsDropped: 'configControlsDropped',
    controlsKeyboardRestored: 'configControlsKeyboardRestored',
    controlsPadOnly: 'configControlsPadOnly',
    languageDropped: 'configLanguageDropped',
    aspectDropped: 'configAspectDropped',
    shaderDropped: 'configShaderDropped',
    latencyDropped: 'configLatencyDropped'
  };

  function exportConfig(): void {
    // Guarded by `disabled` on the button too: exporting while the controls are
    // still in flight would hand the player a file holding defaults they never
    // chose, under a name that says it is theirs.
    if (!controlsConfig) return;

    const now = new Date();
    const blob = new Blob([serialiseConfig(gatherConfig(localStorage, controlsConfig, now))], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = configFileName(now);
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importConfig(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared straight away, so choosing the same file twice fires again -
    // which is exactly what someone does after fixing it by hand.
    input.value = '';
    if (!file) return;

    configBusy = true;
    configMessage = '';
    configError = '';
    configNotices = [];
    try {
      if (file.size > MAX_CONFIG_BYTES) {
        configError = t($language, 'configTooLarge');
        return;
      }

      const result = readConfigFile(await file.text());
      if (!result.ok) {
        configError = t($language, REFUSALS[result.reason]);
        return;
      }

      // The server first, because it is the half that can refuse. The controls
      // go back out through PUT /api/user/controls rather than into the column:
      // that route validates a second time and writes through
      // `writeUserControls`, which invalidates the five-minute cache the room
      // reads player 1's keys from. A write that skipped it would leave a room
      // on the old bindings, and the symptom would appear minutes later on a
      // different screen.
      if (result.config.controls) {
        const res = await fetch('/api/user/controls', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(result.config.controls)
        });
        if (!res.ok) {
          configError = t($language, 'configControlsRefused');
          return;
        }
        controlsConfig = normaliseControlsConfig((await res.json()).config);
      }

      applyConfig(localStorage, result.config);
      shader = readShaderPreference(localStorage);
      // The store caches the language it read at boot; the import wrote past it.
      language.refresh();

      configNotices = result.notices;
      configMessage = t($language, 'configImported');
    } catch (error) {
      logger.error('Configuration import failed', error);
      configError = t($language, 'configImportFailed');
    } finally {
      configBusy = false;
    }
  }

  async function refreshMetadata(): Promise<void> {
    refreshing = true;
    refreshMessage = '';
    try {
      const res = await fetch('/api/games/refresh-metadata', {
        method: 'POST',
        credentials: 'include'
      });
      if (res.ok) {
        const result = await res.json();
        refreshMessage = t($language, 'metadataUpdated', {
          updated: result.updated,
          skipped: result.skipped
        });
      } else {
        refreshMessage = t($language, 'metadataUpdateFailed');
      }
    } catch {
      refreshMessage = t($language, 'metadataUpdateFailed');
    } finally {
      refreshing = false;
    }
  }

  async function logout(): Promise<void> {
    loggingOut = true;
    logoutMessage = '';
    try {
      const res = await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
      // Only a genuinely successful response clears the client session. On a
      // rejection or a non-ok status the server session may still be live, so
      // pretending the user is signed out would be the actual harm here - on a
      // shared machine, worse than the inconvenience of showing an error.
      if (res.ok) {
        user.set(null);
        void goto('/');
      } else {
        logoutMessage = t($language, 'logoutFailed');
      }
    } catch {
      logoutMessage = t($language, 'logoutFailed');
    } finally {
      loggingOut = false;
    }
  }
</script>

<TopBar />

<main class="profile">
  <header class="identity">
    <div class="avatar">
      {#if $user?.avatar}
        <img src={$user.avatar} alt={$user.pseudo} />
      {:else}
        <span class="placeholder">👤</span>
      {/if}
    </div>
    <div class="who">
      <h1>{$user?.pseudo ?? ''}</h1>
      <!--
        The code, standing exactly where the email used to. This is what a
        player gives to someone who wants to add them: there is no way to
        search for an account any more.
      -->
      <p class="handle">
        <code>{handle}</code>
        <button class="copy" on:click={copyHandle} disabled={!handle}>
          {copied ? t($language, 'handleCopied') : t($language, 'copyHandle')}
        </button>
      </p>

      <form class="rename" on:submit|preventDefault={renamePseudo}>
        <label for="pseudo-field">{t($language, 'changePseudo')}</label>
        <div class="rename-row">
          <input
            id="pseudo-field"
            type="text"
            bind:value={pseudoDraft}
            autocomplete="off"
            spellcheck="false"
            maxlength={PSEUDO_MAX}
            aria-invalid={pseudoMalformed}
          />
          <button type="submit" disabled={!canRename}>
            {renaming ? t($language, 'saving') : t($language, 'save')}
          </button>
        </div>
        <p class="note" class:error={pseudoMalformed || !!renameError}>
          {renameError || t($language, 'pseudoRules', { min: PSEUDO_MIN, max: PSEUDO_MAX })}
        </p>
        <!-- Said plainly, because it is the one surprising consequence: the
             discriminator is drawn afresh, so a code shared earlier stops
             resolving. -->
        <p class="note">{t($language, 'renameChangesCode')}</p>
      </form>
    </div>
  </header>

  <!-- The controls card always spans the full grid width: it needs the
       whole page width for its two side-by-side pad drawings (46rem
       threshold), which the narrower of the two `.columns` tracks can never
       give it. `.stack` spans too, so it lands in its own row below rather
       than leaving the other track empty. -->
  <div class="columns">
    <section class="card controls-card">
      <h2>{t($language, 'controls')}</h2>
      {#if controlsConfig}
        <ControlsSettings
          headingLevel={3}
          currentConfig={controlsConfig}
          on:saved={(e) => (controlsConfig = e.detail.config)}
        />
      {:else if controlsError}
        <p class="note">{controlsError}</p>
      {/if}
    </section>

    <div class="stack">
      <RomSourcePanel {missingCount}>
        <div slot="fallback" class="rom-fallback">
          <button on:click={() => fileInput.click()} disabled={romBusy}>
            {t($language, 'chooseOneRom')}
          </button>
          <input
            bind:this={fileInput}
            type="file"
            accept={ACCEPT}
            class="hidden-input"
            on:change={onFileChosen}
          />
          {#if romProgress}
            <p class="note">{romProgress}</p>
          {/if}
          {#if romAdded && !romBusy}
            <p class="note">1 {t($language, 'gamesAdded')}</p>
          {/if}
          {#if romError}
            <p class="note error">{romError}</p>
          {/if}
        </div>
      </RomSourcePanel>

      <section class="card">
        <h2>{t($language, 'display')}</h2>
        <div class="shaders">
          {#each SHADERS as option}
            <button
              class="shader"
              class:on={shader === option.id}
              aria-pressed={shader === option.id}
              on:click={() => chooseShader(option.id)}
            >
              <!-- alt is empty on purpose: the caption beside it already
                   names the shader, so describing the picture too would say
                   the same thing twice to a screen reader. -->
              <img class="shot" src={option.preview} alt="" loading="lazy" />
              <span class="shader-name">{t($language, option.name)}</span>
            </button>
          {/each}
        </div>
      </section>

      <section class="card">
        <h2>{t($language, 'language')}</h2>
        <LanguageSelector />
      </section>

      <section class="card">
        <h2>{t($language, 'myConfiguration')}</h2>
        <p class="note">{t($language, 'configExplain')}</p>
        <div class="config-actions">
          <button on:click={exportConfig} disabled={!controlsConfig || configBusy}>
            {t($language, 'exportConfiguration')}
          </button>
          <label class="import">
            <span>{t($language, 'importConfiguration')}</span>
            <input
              type="file"
              accept="application/json,.json"
              disabled={configBusy}
              on:change={importConfig}
            />
          </label>
        </div>
        {#if configMessage}<p class="note">{configMessage}</p>{/if}
        {#if configError}<p class="note error">{configError}</p>{/if}
        {#each configNotices as notice}
          <p class="note">{t($language, NOTICES[notice])}</p>
        {/each}
      </section>

      <section class="card">
        <h2>{t($language, 'library')}</h2>
        <button on:click={refreshMetadata} disabled={refreshing}>
          {refreshing ? t($language, 'updating') : t($language, 'updateMetadata')}
        </button>
        {#if refreshMessage}<p class="note">{refreshMessage}</p>{/if}
      </section>
    </div>
  </div>

  <section class="card danger">
    <div class="danger-row">
      <p class="danger-note">{t($language, 'logoutFromThisDevice')}</p>
      <button class="logout" on:click={logout} disabled={loggingOut}>
        {t($language, 'logout')}
      </button>
    </div>
    {#if logoutMessage}<p class="note error">{logoutMessage}</p>{/if}
  </section>
</main>

<style>
  .profile {
    /* Explicit, not auto: `.profile` is a flex item of `.app`
       (flex-direction: column), so its cross axis is horizontal. A flex
       item with horizontal auto margins has its cross-axis alignment -
       align-items: stretch, here - overridden by those margins, so an
       `auto` width would shrink-wrap to content instead of filling up to
       max-width. That happened to look fine only because some sibling
       (the Display card's shader tiles, at the time) had enough natural
       width to drag the shrink-to-fit basis up near the cap - the
       controls card's own 46rem container-query threshold was riding on
       a neighbour's content, not on the page. `width: 100%` makes the
       size explicit, so `margin: 0 auto` just centers the already-full
       width within any space `max-width` leaves, as intended. */
    width: 100%;
    max-width: 68rem;
    margin: 0 auto;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  /* The one look every block on this page shares. Repeated in
     RomSourcePanel rather than made global, because Svelte scopes styles and
     that panel owns its own markup. */
  .card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 14px;
    padding: 1.25rem;
  }

  .identity {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding: 0.5rem 0 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  }

  .avatar {
    width: 5.5rem;
    height: 5.5rem;
    border-radius: 50%;
    overflow: hidden;
    background: #333;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border: 2px solid rgba(102, 126, 234, 0.5);
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .placeholder {
    font-size: 2.5rem;
  }

  h1 {
    margin: 0;
    font-size: 1.75rem;
  }

  h2 {
    margin: 0 0 0.75rem;
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9aa0b4;
  }

  .handle {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0.35rem 0 0;
    color: #aaa;
  }

  .handle code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 1rem;
    color: #9fb4ff;
  }

  .copy {
    padding: 0.2rem 0.6rem;
    border: 1px solid #444;
    border-radius: 6px;
    background: transparent;
    color: #ccc;
    font-size: 0.72rem;
    cursor: pointer;
  }

  .copy:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .rename {
    margin-top: 1rem;
    max-width: 22rem;
  }

  .rename label {
    display: block;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9aa0b4;
    margin-bottom: 0.35rem;
  }

  .rename-row {
    display: flex;
    gap: 0.5rem;
  }

  .rename-row input {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.65rem;
    border: 1px solid #444;
    border-radius: 6px;
    background: #1a1a1a;
    color: #eee;
    font-size: 0.9rem;
  }

  .rename-row input[aria-invalid='true'] {
    border-color: #b3564b;
  }

  .rename-row button {
    padding: 0 0.9rem;
    border: 0;
    border-radius: 6px;
    /* Pas le #667eea de la marque : 3.66:1 sous du blanc, sous les 4.5
       qu'AA demande. Même teinte, assombrie jusqu'à 4.96:1. */
    background: #4764e6;
    color: white;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .rename-row button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .columns {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.5rem;
    align-items: start;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  /* The controls card needs the full page width, not a share of it - see the
     comment above the markup. It and .stack both span every track, so
     neither `.columns` layout below leaves the other track's row empty. */
  .controls-card {
    grid-column: 1 / -1;
  }

  .stack {
    grid-column: 1 / -1;
  }

  /* 900px was too eager: it gave the controls card about 420px, which is
     under what two columns of key bindings need. Past 1200px this no longer
     changes the layout - both grid children span every track above - but the
     definition is kept in case a future track is added that should use it. */
  @media (min-width: 1200px) {
    .columns {
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    }
  }

  /* Tiles rather than a row of names: the preview is the reason this section
     exists, so it gets the space and the label becomes the caption. */
  .shaders {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr));
    gap: 0.6rem;
  }

  .shader {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.4rem;
    background: rgba(255, 255, 255, 0.03);
    border: 2px solid transparent;
    text-align: center;
  }

  .shader:hover:not(.on) {
    background: rgba(255, 255, 255, 0.07);
  }

  .shader.on {
    background: rgba(102, 126, 234, 0.15);
    border-color: #667eea;
  }

  .shot {
    display: block;
    width: 100%;
    /* The captures are hand-cropped to slightly different sizes, so a fixed
       box plus cover frames them identically instead of letting the tiles
       jitter by a few pixels. */
    aspect-ratio: 8 / 7;
    object-fit: cover;
    border-radius: 6px;
    background: #000;
  }

  .shader-name {
    font-size: 0.8rem;
    color: #ccc;
  }

  .shader.on .shader-name {
    color: #fff;
  }

  button {
    background: #333;
    border: 2px solid transparent;
    color: #fff;
    padding: 0.45rem 0.8rem;
    border-radius: 8px;
    cursor: pointer;
    transition:
      background 0.15s,
      border-color 0.15s;
  }

  button:hover:not(:disabled) {
    background: #3d3d3d;
  }

  button.on {
    background: #3a4a5a;
    border-color: #667eea;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .note {
    margin: 0.5rem 0 0;
    color: #aaa;
    font-size: 0.9rem;
  }

  .config-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  /* The file input itself is unstyleable across browsers, so the label is the
     control and the input is hidden inside it - clicking the label opens the
     picker, and keyboard focus still lands on the input. */
  .import {
    position: relative;
    overflow: hidden;
    display: inline-flex;
    align-items: center;
    background: #333;
    border: 2px solid transparent;
    color: #fff;
    padding: 0.45rem 0.8rem;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s;
  }

  .import:hover {
    background: #444;
  }

  .import:focus-within {
    border-color: #666;
  }

  .import:has(input:disabled) {
    opacity: 0.5;
    cursor: default;
  }

  .import input {
    position: absolute;
    inset: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
  }

  .note.error {
    color: #f87171;
  }

  .rom-fallback {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
  }

  .hidden-input {
    display: none;
  }

  /* Framed and labelled rather than a lone red button: the border says the
     block is different before the colour does. */
  .danger {
    border-color: rgba(248, 113, 113, 0.25);
    background: rgba(248, 113, 113, 0.04);
  }

  .danger-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .danger-note {
    margin: 0;
    color: #aaa;
    font-size: 0.9rem;
  }

  .logout {
    background: #7f1d1d;
  }

  .logout:hover:not(:disabled) {
    background: #991b1b;
  }
</style>
