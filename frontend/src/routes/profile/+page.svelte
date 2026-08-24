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

  const logger = createLogger('ProfilePage');

  // The bar is the same one the library page shows, so the page keeps its
  // chrome instead of stranding the user with a lone back link. It needs the
  // active rooms for the friends drawer's join buttons.
  let activeRooms: any[] = [];
  let controlsConfig: ControlsConfig | null = null;
  let controlsError = '';
  let shader = '';
  let refreshing = false;
  let refreshMessage = '';
  let loggingOut = false;
  let logoutMessage = '';

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

    try {
      const res = await fetch('/api/rooms', { credentials: 'include' });
      // A drawer that cannot offer "join" is a smaller loss than a page that
      // fails to render, so this stays quiet on failure.
      if (res.ok) activeRooms = await res.json();
    } catch (err) {
      logger.error('Could not load active rooms', err);
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

<TopBar {activeRooms} />

<div class="profile">
  <header class="identity">
    <div class="avatar">
      {#if $user?.avatar}
        <img src={$user.avatar} alt={$user.displayName} />
      {:else}
        <span class="placeholder">👤</span>
      {/if}
    </div>
    <div class="who">
      <h1>{$user?.displayName ?? ''}</h1>
      <p class="email">{$user?.email ?? ''}</p>
    </div>
  </header>

  <!-- Two columns past 900px. Controls is the tall one, so it gets a column to
       itself and the short cards stack beside it rather than under it. -->
  <div class="columns">
    <section class="card">
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

  .email {
    margin: 0.35rem 0 0;
    color: #aaa;
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

  /* 900px was too eager: it gave the controls card about 420px, which is
     under what two columns of key bindings need, so the page went
     side-by-side exactly when its widest block could no longer afford it.
     Past 1200px the controls column takes the larger share and stays wide
     enough to keep its own two columns. */
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
