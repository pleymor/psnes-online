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
  import { createEventDispatcher, onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { romSourceState, type RomSourceState } from '$lib/roms/source-state';
  import { pickerError } from '$lib/roms/picker-error';
  import {
    supportsDirectoryPicker,
    chooseDirectory,
    storedDirectory,
    ensureAccess
  } from '$lib/roms/local-library';

  const dispatch = createEventDispatcher();

  let state: RomSourceState = { kind: 'no-folder' };
  let busy = false;
  let error = '';

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
    try {
      if (await chooseDirectory()) dispatch('changed');
      await refresh();
    } catch (err) {
      const message = pickerError(err);
      if (message) error = message;
    } finally {
      busy = false;
    }
  }

  onMount(refresh);
</script>

<section class="rom-source">
  <h3>{t($language, 'romSource')}</h3>

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

  {#if error}
    <p class="error">{error}</p>
  {/if}
</section>

<style>
  .rom-source {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
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
