<script lang="ts">
  /**
   * Where this machine's ROMs come from.
   *
   * Replaces the "add games" modal. ROMs stopped living on the server, so the
   * library is a list of identities and the files come from a folder - which
   * makes configuring the folder once the right shape, and adding games one at
   * a time the shape of before.
   *
   * It has two forms, and the second is not a consolation prize shown
   * everywhere: folder selection needs `showDirectoryPicker`, which only
   * Chromium has. Without the single-file fallback, Firefox and Safari would
   * have a permanently empty library and no recourse.
   */
  import { onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import { romSourceState, type RomSourceState } from '$lib/roms/source-state';
  import { pickerError } from '$lib/roms/picker-error';
  import {
    supportsDirectoryPicker,
    chooseDirectory,
    storedDirectory,
    ensureAccess,
    scanDirectory,
    registerGame,
    type LibraryEntry
  } from '$lib/roms/local-library';

  const logger = createLogger('RomSourcePanel');

  let state: RomSourceState = { kind: 'no-folder' };
  let busy = false;
  let error = '';
  let progress = '';
  let added = 0;

  /**
   * Combien de jeux du compte cet appareil ne peut pas ouvrir.
   *
   * La bibliothèque les masque, ce qui est le comportement demandé ; les faire
   * disparaître sans le dire nulle part serait un autre mensonge. Ici est
   * l'endroit : on y vient déjà pour configurer ses ROMs.
   */
  export let missingCount = 0;

  /**
   * Scans a folder and registers everything found in it.
   *
   * Called from pickFolder once a working handle exists - whether that
   * handle came from picking a new folder or re-granting access to a
   * remembered one - because either can leave the library with games it
   * does not know about yet.
   */
  async function scanAndRegister(handle: FileSystemDirectoryHandle): Promise<void> {
    progress = t($language, 'scanningFolder');
    const entries: LibraryEntry[] = await scanDirectory(handle);
    if (entries.length === 0) {
      error = t($language, 'noRomsFound');
      return;
    }

    for (const [index, entry] of entries.entries()) {
      progress = `${index + 1}/${entries.length} · ${entry.filename}`;
      try {
        await registerGame(entry.checksum, entry.filename);
        added++;
      } catch (err) {
        // One unreadable ROM must not abandon the rest of a forty-cartridge
        // folder. A game already in the library does NOT arrive here: the
        // server looks the checksum up and answers 200 with the existing
        // game, so re-scanning a folder is a safe no-op.
        logger.warn(`Could not add ${entry.filename}`, err);
      }
    }

    // Every entry failing looks exactly like a completed scan unless said
    // out loud - the player just watched forty cartridges scroll by for
    // nothing.
    if (added === 0) error = t($language, 'romsNoneAdded');
  }

  /**
   * Gathers the facts, then lets the pure function decide.
   *
   * The split is deliberate: the gathering needs three browser APIs and a
   * permission check, and the decision is the part that can be wrong without
   * anyone seeing it.
   */
  async function refresh(): Promise<void> {
    try {
      const supported = supportsDirectoryPicker();
      if (!supported) {
        state = romSourceState({ supported: false });
        return;
      }
      const handle = await storedDirectory();
      if (!handle) {
        state = romSourceState({ supported: true });
        return;
      }
      state = romSourceState({
        supported: true,
        folderName: handle.name,
        accessGranted: await ensureAccess(handle)
      });
    } catch (err) {
      // A remembered folder that was since moved or deleted must not vanish
      // as an unhandled rejection - the player is left staring at a stale
      // "no folder" state with no idea why.
      const message = pickerError(err);
      if (message) error = message;
    }
  }

  async function pickFolder(): Promise<void> {
    busy = true;
    error = '';
    progress = '';
    added = 0;
    try {
      if (await chooseDirectory()) {
        const handle = await storedDirectory();
        if (handle) await scanAndRegister(handle);
      }
      await refresh();
    } catch (err) {
      const message = pickerError(err);
      if (message) error = message;
    } finally {
      busy = false;
      progress = '';
    }
  }

  onMount(refresh);
</script>

<section class="rom-source">
  <h3>{t($language, 'romSource')}</h3>
  {#if missingCount > 0}
    <p class="explain">{missingCount} {t($language, 'gamesNotOnThisDevice')}</p>
  {/if}
  <p class="legal">{t($language, 'legalUploadWarning')}</p>

  {#if state.kind === 'unsupported'}
    <p class="explain">{t($language, 'romFolderUnsupported')}</p>
    <!-- The single-file path lives here and only here: shown where a folder
         cannot be remembered, so it costs nothing to anyone else. -->
    <slot name="fallback" />
  {:else if state.kind === 'folder'}
    <p class="current">{t($language, 'romFolderCurrent')} <strong>{state.name}</strong></p>
    <button on:click={pickFolder} disabled={busy}>{t($language, 'romFolderChange')}</button>
  {:else if state.kind === 'folder-stale'}
    <p class="explain">
      {t($language, 'romFolderStale')} <strong>{state.name}</strong>
    </p>
    <button on:click={pickFolder} disabled={busy}>{t($language, 'romFolderRegrant')}</button>
  {:else}
    <p class="explain">{t($language, 'romsStayLocal')}</p>
    <button on:click={pickFolder} disabled={busy}>{t($language, 'chooseRomFolder')}</button>
  {/if}

  {#if progress}
    <p class="explain">{progress}</p>
  {/if}
  {#if added > 0 && !busy}
    <p class="explain">{added} {t($language, 'gamesAdded')}</p>
  {/if}
  {#if error}
    <p class="error">{error}</p>
  {/if}
</section>

<style>
  /* The same card look the profile page gives its own sections. Repeated
     here rather than shared, because Svelte scopes styles to the component
     that owns the markup. */
  .rom-source {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 14px;
    padding: 1.25rem;
  }

  .rom-source h3 {
    margin: 0 0 0.25rem;
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9aa0b4;
  }

  h3 {
    margin: 0;
  }

  .explain,
  .current {
    margin: 0;
    color: #aaa;
    font-size: 0.9rem;
  }

  .error {
    margin: 0;
    color: #f87171;
    font-size: 0.9rem;
  }

  .legal {
    margin: 0;
    font-size: 0.75rem;
    color: #6f6f88;
    line-height: 1.4;
  }

  button {
    background: #333;
    border: 2px solid transparent;
    color: #fff;
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
