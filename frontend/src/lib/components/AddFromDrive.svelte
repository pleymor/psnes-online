<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import { openDrivePicker, getAccessToken, type DriveFile } from '$lib/services/drive-picker';

  const dispatch = createEventDispatcher();
  const logger = createLogger('AddFromDrive');

  let title = '';
  let selectedFile: DriveFile | null = null;
  let loading = false;
  let error = '';

  async function handlePickFile() {
    loading = true;
    error = '';

    try {
      const accessToken = await getAccessToken();
      const file = await openDrivePicker(accessToken);

      if (file) {
        selectedFile = file;
        // Auto-fill title from filename
        title = file.fileName.replace(/\.(smc|sfc|fig|swc|mgd|zip)$/i, '');
      }
    } catch (err: any) {
      logger.error('Drive picker error:', err);
      error = err.message || 'Failed to open Drive picker';
    } finally {
      loading = false;
    }
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

<div class="modal-backdrop" on:click={() => dispatch('close')} on:keydown={() => {}}>
  <div class="modal" on:click|stopPropagation on:keydown|stopPropagation>
    <h2>{t($language, 'addFromDrive')}</h2>

    <div class="info-notice">
      <strong>Google Drive</strong>
      <p>{t($language, 'driveInfo')}</p>
    </div>

    {#if error}
      <div class="error-message">{error}</div>
    {/if}

    <form on:submit|preventDefault={handleSubmit}>
      {#if !selectedFile}
        <div class="picker-section">
          <p>{t($language, 'selectRomFromDrive')}</p>
          <button type="button" on:click={handlePickFile} disabled={loading} class="btn-pick">
            {loading ? t($language, 'loading') : t($language, 'openDrivePicker')}
          </button>
        </div>
      {:else}
        <div class="selected-file">
          <div class="file-info">
            <span class="file-icon">📁</span>
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
    max-width: 500px;
    width: 90%;
  }

  h2 {
    margin-top: 0;
  }

  .info-notice {
    background: rgba(66, 133, 244, 0.15);
    border: 1px solid rgba(66, 133, 244, 0.5);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1.5rem;
  }

  .info-notice strong {
    color: #4285f4;
    display: block;
    margin-bottom: 0.5rem;
  }

  .info-notice p {
    margin: 0;
    font-size: 0.85rem;
    color: #ddd;
    line-height: 1.5;
  }

  .error-message {
    background: rgba(244, 67, 54, 0.15);
    border: 1px solid rgba(244, 67, 54, 0.5);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1.5rem;
    color: #f44336;
  }

  .picker-section {
    text-align: center;
    padding: 2rem 0;
  }

  .picker-section p {
    color: #aaa;
    margin-bottom: 1.5rem;
  }

  .btn-pick {
    background: linear-gradient(135deg, #4285f4 0%, #34a853 100%);
    color: white;
    border: none;
    padding: 1rem 2rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    font-weight: 500;
  }

  .btn-pick:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-pick:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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
