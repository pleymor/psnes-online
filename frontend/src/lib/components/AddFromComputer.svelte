<script lang="ts">
  /**
   * Add a ROM from the player's own machine.
   *
   * The counterpart to AddFromDrive, and the only route into the library that
   * does not need a Google account — which also makes it the only way to run
   * the app locally.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('AddFromComputer');
  const dispatch = createEventDispatcher();

  const ACCEPT = '.smc,.sfc,.fig,.swc,.mgd,.zip';
  const MAX_BYTES = 8 * 1024 * 1024;

  let fileInput: HTMLInputElement;
  let selectedFile: File | null = null;
  let title = '';
  let loading = false;
  let error = '';
  let dragging = false;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !loading) dispatch('close');
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  function accept(file: File | undefined | null) {
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
    error = '';
    selectedFile = file;
    // Pre-fill from the filename; the server still prefers a CRC32 match, so
    // this only matters for ROMs it does not recognise.
    if (!title) title = file.name.replace(/\.[^.]+$/, '');
  }

  // A named handler rather than an inline arrow: the Svelte 4 template parser
  // does not accept a TypeScript `as` cast inside an event expression.
  function onFileChosen(event: Event) {
    accept((event.currentTarget as HTMLInputElement).files?.[0]);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    accept(event.dataTransfer?.files?.[0]);
  }

  async function upload() {
    if (!selectedFile || loading) return;
    loading = true;
    error = '';

    try {
      const body = new FormData();
      body.append('rom', selectedFile);
      if (title.trim()) body.append('title', title.trim());

      const res = await fetch('/api/games/upload', {
        method: 'POST',
        credentials: 'include',
        body
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${res.status}`);
      }

      dispatch('added');
    } catch (err) {
      logger.error('ROM upload failed', err);
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }
</script>

<div
  class="backdrop"
  role="presentation"
  on:click={() => !loading && dispatch('close')}
>
  <div class="modal" role="dialog" aria-modal="true" on:click|stopPropagation>
    <h2>{t($language, 'addFromComputer')}</h2>

    <div
      class="dropzone"
      class:dragging
      class:filled={!!selectedFile}
      role="button"
      tabindex="0"
      on:click={() => fileInput.click()}
      on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.click()}
      on:dragover|preventDefault={() => (dragging = true)}
      on:dragleave={() => (dragging = false)}
      on:drop={onDrop}
    >
      {#if selectedFile}
        <strong>{selectedFile.name}</strong>
        <span class="size">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</span>
      {:else}
        <span>{t($language, 'romDropHint')}</span>
        <span class="hint">{ACCEPT}</span>
      {/if}
    </div>

    <input
      bind:this={fileInput}
      type="file"
      accept={ACCEPT}
      class="hidden-input"
      on:change={onFileChosen}
    />

    <label class="field">
      <span>{t($language, 'gameTitle')}</span>
      <input type="text" bind:value={title} placeholder={t($language, 'gameTitle')} />
    </label>

    <p class="legal">{t($language, 'legalUploadWarning')}</p>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <div class="actions">
      <button class="secondary" on:click={() => dispatch('close')} disabled={loading}>
        {t($language, 'cancel')}
      </button>
      <button class="primary" on:click={upload} disabled={!selectedFile || loading}>
        {loading ? t($language, 'loading') : t($language, 'addGame')}
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
    gap: 1rem;
  }

  h2 {
    margin: 0;
    font-size: 1.25rem;
    color: #fff;
  }

  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-height: 130px;
    padding: 1rem;
    border: 2px dashed #3d3d52;
    border-radius: 10px;
    color: #8b8ba3;
    cursor: pointer;
    text-align: center;
    transition: border-color 0.15s, background 0.15s;
  }

  .dropzone:hover,
  .dropzone.dragging {
    border-color: #667eea;
    background: rgba(102, 126, 234, 0.08);
  }

  .dropzone.filled {
    border-style: solid;
    color: #e6e6f0;
  }

  .dropzone .hint,
  .dropzone .size {
    font-size: 0.8rem;
    color: #6f6f88;
  }

  .hidden-input {
    display: none;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.85rem;
    color: #8b8ba3;
  }

  .field input {
    background: #12121a;
    border: 1px solid #2c2c3c;
    border-radius: 6px;
    padding: 0.5rem 0.7rem;
    color: #e6e6f0;
    font-size: 0.95rem;
  }

  .legal {
    margin: 0;
    font-size: 0.75rem;
    color: #6f6f88;
    line-height: 1.4;
  }

  .error {
    margin: 0;
    color: #ff8f8f;
    font-size: 0.85rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
  }

  button {
    border-radius: 6px;
    padding: 0.5rem 1.1rem;
    font-size: 0.9rem;
    cursor: pointer;
    border: 1px solid transparent;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .secondary {
    background: transparent;
    border-color: #3d3d52;
    color: #b7b7cc;
  }

  .primary {
    background: #667eea;
    color: #fff;
  }
</style>
