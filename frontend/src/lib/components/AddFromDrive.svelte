<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import DriveFolderBrowser from './DriveFolderBrowser.svelte';

  const dispatch = createEventDispatcher();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') dispatch('close');
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });
  const logger = createLogger('AddFromDrive');

  interface DriveFile {
    fileId: string;
    fileName: string;
    mimeType: string;
  }

  let title = '';
  let selectedFile: DriveFile | null = null;
  let loading = false;
  let error = '';

  function handleFileSelect(event: CustomEvent<{ fileId: string; fileName: string; mimeType: string }>) {
    const file = event.detail;
    selectedFile = {
      fileId: file.fileId,
      fileName: file.fileName,
      mimeType: file.mimeType
    };
    // Auto-fill title from filename
    title = file.fileName.replace(/\.(smc|sfc|fig|swc|mgd|zip)$/i, '');
  }

  async function handleSubmit() {
    if (!selectedFile || !title) return;

    loading = true;
    error = '';

    try {
      const res = await fetch('/api/games/add-from-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          driveFileId: selectedFile.fileId,
          driveFileName: selectedFile.fileName,
          title
        })
      });

      if (res.ok) {
        dispatch('close');
        dispatch('added');
      } else {
        const data = await res.json();
        error = data.error || 'Failed to add game';
        logger.error('Add from Drive failed:', data);
      }
    } catch (err: any) {
      error = err.message || 'Failed to add game';
      logger.error('Add from Drive error:', err);
    } finally {
      loading = false;
    }
  }

  function clearSelection() {
    selectedFile = null;
    title = '';
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="modal-backdrop" role="presentation" on:click={() => dispatch('close')}>
  <div class="modal" role="dialog" aria-modal="true" on:click|stopPropagation>
    <h2>{t($language, 'addFromDrive')}</h2>

    <div class="legal-warning">
      <p><strong>{t($language, 'legalWarning')}</strong></p>
      <p>{t($language, 'legalUploadWarning')}</p>
    </div>

    {#if error}
      <div class="error-message">{error}</div>
    {/if}

    <form on:submit|preventDefault={handleSubmit}>
      {#if !selectedFile}
        <div class="browser-section">
          <DriveFolderBrowser on:select={handleFileSelect} />
        </div>
      {:else}
        <div class="selected-file">
          <div class="file-info">
            <span class="file-icon">🎮</span>
            <span class="file-name">{selectedFile.fileName}</span>
          </div>
          <button type="button" on:click={clearSelection} class="btn-change">
            {t($language, 'changeFile')}
          </button>
        </div>

        <div class="field">
          <label for="title">{t($language, 'gameTitle')}</label>
          <input
            id="title"
            type="text"
            bind:value={title}
            required
            placeholder="Super Mario World"
          />
        </div>

        <div class="actions">
          <button type="submit" disabled={!title || loading} class="btn-add">
            {loading ? t($language, 'adding') : t($language, 'addToLibrary')}
          </button>
          <button type="button" on:click={() => dispatch('close')} class="btn-cancel">
            {t($language, 'cancel')}
          </button>
        </div>
      {/if}
    </form>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  }

  .modal {
    background: #2a2a2a;
    padding: 2rem;
    border-radius: 12px;
    max-width: 600px;
    width: 95%;
    max-height: 90vh;
    overflow-y: auto;
  }

  h2 {
    margin-top: 0;
  }

  .legal-warning {
    background: rgba(255, 152, 0, 0.1);
    border: 1px solid rgba(255, 152, 0, 0.3);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1.5rem;
  }

  .legal-warning strong {
    color: #ff9800;
  }

  .legal-warning p {
    margin: 0;
    font-size: 0.85rem;
    color: #ddd;
    line-height: 1.5;
  }

  .legal-warning p:first-child {
    margin-bottom: 0.5rem;
  }

  .error-message {
    background: rgba(244, 67, 54, 0.15);
    border: 1px solid rgba(244, 67, 54, 0.5);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1.5rem;
    color: #f44336;
  }

  .browser-section {
    margin-bottom: 1rem;
  }

  .selected-file {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #1a1a1a;
    padding: 1rem;
    border-radius: 8px;
    margin-bottom: 1.5rem;
  }

  .file-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .file-icon {
    font-size: 1.5rem;
  }

  .file-name {
    color: #fff;
    font-weight: 500;
  }

  .btn-change {
    background: #444;
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .field {
    margin-bottom: 1.5rem;
  }

  label {
    display: block;
    margin-bottom: 0.5rem;
    color: #ddd;
  }

  input[type="text"] {
    width: 100%;
    padding: 0.75rem;
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 6px;
    color: white;
    font-size: 1rem;
  }

  .actions {
    display: flex;
    gap: 1rem;
    margin-top: 2rem;
  }

  .btn-add {
    flex: 1;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1rem;
  }

  .btn-add:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-cancel {
    flex: 1;
    background: #444;
    color: white;
    border: none;
    padding: 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1rem;
  }
</style>
