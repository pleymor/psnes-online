<script lang="ts">
  /**
   * Adds games to the library without uploading anything.
   *
   * What gets sent is a checksum and a filename; the ROM itself stays on the
   * player's machine. The folder path is offered first and deliberately
   * prominent - it is one gesture for a whole shelf of cartridges, and it is
   * also what lets every later launch find its file without asking again.
   * Picking a single file works everywhere, including browsers with no
   * directory API, but it has to be repeated per game.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import {
    chooseDirectory,
    ensureAccess,
    scanDirectory,
    storedDirectory,
    supportsDirectoryPicker,
    checksumOf,
    type LibraryEntry
  } from '$lib/roms/local-library';

  const logger = createLogger('AddGames');
  const dispatch = createEventDispatcher<{ close: void; added: void }>();

  const ACCEPT = '.smc,.sfc,.fig,.swc,.mgd,.zip';
  const MAX_BYTES = 8 * 1024 * 1024;

  let fileInput: HTMLInputElement;
  let busy = false;
  let error = '';
  let progress = '';
  let added = 0;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) dispatch('close');
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  /** Registers one game: its identity, never its contents. */
  async function register(checksum: string, filename: string): Promise<boolean> {
    const res = await fetch('/api/games', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checksum, filename })
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${res.status}`);
    }
    return true;
  }

  async function pickFolder() {
    busy = true;
    error = '';
    added = 0;
    try {
      if (!(await chooseDirectory())) return;
      const handle = await storedDirectory();
      if (!handle || !(await ensureAccess(handle))) return;

      progress = t($language, 'scanningFolder');
      const entries: LibraryEntry[] = await scanDirectory(handle);
      if (entries.length === 0) {
        error = t($language, 'noRomsFound');
        return;
      }

      for (const [index, entry] of entries.entries()) {
        progress = `${index + 1}/${entries.length} · ${entry.filename}`;
        try {
          await register(entry.checksum, entry.filename);
          added++;
        } catch (err) {
          // One unreadable or duplicate ROM must not abandon the rest of a
          // forty-cartridge folder.
          logger.warn(`Could not add ${entry.filename}`, err);
        }
      }

      dispatch('added');
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        error = err instanceof Error ? err.message : String(err);
        logger.error('Folder scan failed', err);
      }
    } finally {
      busy = false;
      progress = '';
    }
  }

  async function onFileChosen(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;

    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ACCEPT.split(',').includes(ext)) {
      error = t($language, 'romInvalidType');
      return;
    }
    if (file.size > MAX_BYTES) {
      error = t($language, 'romTooLarge');
      return;
    }

    busy = true;
    error = '';
    try {
      progress = file.name;
      await register(await checksumOf(file), file.name);
      dispatch('added');
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error('Could not add the game', err);
    } finally {
      busy = false;
      progress = '';
    }
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="backdrop" role="presentation" on:click={() => !busy && dispatch('close')}>
  <div class="modal" role="dialog" aria-modal="true" on:click|stopPropagation>
    <h2>{t($language, 'addGames')}</h2>
    <p class="explain">{t($language, 'romsStayLocal')}</p>

    {#if supportsDirectoryPicker()}
      <button class="choice primary-choice" on:click={pickFolder} disabled={busy}>
        <span class="choice-icon">📁</span>
        <span class="choice-text">
          <strong>{t($language, 'chooseRomFolder')}</strong>
          <small>{t($language, 'chooseRomFolderHint')}</small>
        </span>
      </button>
    {/if}

    <button class="choice" on:click={() => fileInput.click()} disabled={busy}>
      <span class="choice-icon">💾</span>
      <span class="choice-text">
        <strong>{t($language, 'chooseOneRom')}</strong>
        <small>{ACCEPT}</small>
      </span>
    </button>

    <input
      bind:this={fileInput}
      type="file"
      accept={ACCEPT}
      class="hidden-input"
      on:change={onFileChosen}
    />

    {#if progress}
      <p class="progress">{progress}</p>
    {/if}
    {#if added > 0 && !busy}
      <p class="progress">{added} {t($language, 'gamesAdded')}</p>
    {/if}
    {#if error}
      <p class="error">{error}</p>
    {/if}

    <p class="legal">{t($language, 'legalUploadWarning')}</p>

    <div class="actions">
      <button class="secondary" on:click={() => dispatch('close')} disabled={busy}>
        {t($language, 'cancel')}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }

  .modal {
    background: #1b1b26;
    border: 1px solid #2c2c3c;
    border-radius: 12px;
    padding: 1.5rem;
    width: 100%;
    max-width: 480px;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  h2 {
    margin: 0;
    font-size: 1.25rem;
    color: #fff;
  }

  .explain {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.5;
    color: #8b8ba3;
  }

  .choice {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    text-align: left;
    padding: 0.9rem 1rem;
    border-radius: 10px;
    border: 1px solid #2c2c3c;
    background: #12121a;
    color: #e6e6f0;
    cursor: pointer;
  }

  .choice:hover:not(:disabled) {
    border-color: #667eea;
    background: rgba(102, 126, 234, 0.08);
  }

  .primary-choice {
    border-color: #667eea;
  }

  .choice-icon {
    font-size: 1.5rem;
  }

  .choice-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .choice-text small {
    color: #6f6f88;
    font-size: 0.78rem;
  }

  .hidden-input {
    display: none;
  }

  .progress {
    margin: 0;
    font-size: 0.82rem;
    color: #8b8ba3;
  }

  .error {
    margin: 0;
    color: #ff8f8f;
    font-size: 0.85rem;
  }

  .legal {
    margin: 0;
    font-size: 0.75rem;
    color: #6f6f88;
    line-height: 1.4;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .secondary {
    background: transparent;
    border: 1px solid #3d3d52;
    border-radius: 6px;
    padding: 0.5rem 1.1rem;
    color: #b7b7cc;
    font-size: 0.9rem;
    cursor: pointer;
  }
</style>
