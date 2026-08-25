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
  import { t } from '$lib/i18n/translations';
  import { normaliseControlsConfig, type ControlsConfig } from '$lib/controls/binding';
  import TopBar from '$lib/components/TopBar.svelte';
  import ControlsSettings from '$lib/components/ControlsSettings.svelte';
  import LanguageSelector from '$lib/components/LanguageSelector.svelte';
  import RomSourcePanel from '$lib/components/RomSourcePanel.svelte';
  import { SHADERS } from '$lib/shaders';
  import { readShaderPreference, writeShaderPreference } from '$lib/stores/shader-preference';
  import { romFileProblem, ACCEPT } from '$lib/roms/rom-file';
  import { checksumOf, registerGame } from '$lib/roms/local-library';
  import { createLogger } from '$lib/utils/logger';
  import { formatHandle, isValidPseudo, PSEUDO_MIN, PSEUDO_MAX } from '$lib/pseudo';

  const logger = createLogger('ProfilePage');

  // The bar is the same one the library page shows, so the page keeps its
  // chrome instead of stranding the user with a lone back link. It needs the
  // active rooms for the friends drawer's join buttons.
  let controlsConfig: ControlsConfig | null = null;
  let controlsError = '';
  let shader = '';
  let refreshing = false;
  let refreshMessage = '';
  let loggingOut = false;
  let logoutMessage = '';

  let pseudoDraft = '';
  let renaming = false;
  let renameError = '';
  let copied = false;

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
      await registerGame(await checksumOf(file), file.name);
      romAdded = true;
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

<div class="profile">
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
      <h3>{t($language, 'controls')}</h3>
      {#if controlsConfig}
        <ControlsSettings
          currentConfig={controlsConfig}
          on:saved={(e) => (controlsConfig = e.detail.config)}
        />
      {:else if controlsError}
        <p class="note">{controlsError}</p>
      {/if}
    </section>

    <div class="stack">
      <RomSourcePanel>
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
        <h3>{t($language, 'display')}</h3>
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
        <h3>{t($language, 'language')}</h3>
        <LanguageSelector />
      </section>

      <section class="card">
        <h3>{t($language, 'library')}</h3>
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
</div>

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

  h3 {
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
    background: #667eea;
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
