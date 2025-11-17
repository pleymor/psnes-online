<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';

  const dispatch = createEventDispatcher();

  let title = '';
  let file: File | null = null;
  let uploading = false;

  function handleFileChange(e: Event) {
    const target = e.target as HTMLInputElement;
    file = target.files?.[0] || null;

    if (file && !title) {
      // Auto-fill title from filename
      title = file.name.replace(/\.(smc|sfc|fig|swc|mgd|zip)$/i, '');
    }
  }

  async function handleSubmit() {
    if (!file || !title) return;

    uploading = true;

    const formData = new FormData();
    formData.append('rom', file);
    formData.append('title', title);

    try {
      const res = await fetch('/api/games/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if (res.ok) {
        dispatch('close');
        dispatch('uploaded'); // Notify parent to refresh games list
      } else {
        alert(t($language, 'uploadFailed'));
      }
    } catch (error) {
      alert(t($language, 'uploadError'));
    } finally {
      uploading = false;
    }
  }
</script>

<div class="modal-backdrop" on:click={() => dispatch('close')}>
  <div class="modal" on:click|stopPropagation>
    <h2>{t($language, 'uploadROM')}</h2>

    <div class="legal-notice">
      <strong>⚠️ {t($language, 'legalWarning')}</strong>
      <p>{t($language, 'legalUploadWarning')}</p>
    </div>

    <form on:submit|preventDefault={handleSubmit}>
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

      <div class="field">
        <label for="rom">{t($language, 'romFile')}</label>
        <input
          id="rom"
          type="file"
          accept=".smc,.sfc,.fig,.swc,.mgd,.zip"
          on:change={handleFileChange}
          required
        />
        <small>{t($language, 'supportedFormats')}: .smc, .sfc, .fig, .swc, .mgd, .zip</small>
      </div>

      <div class="actions">
        <button type="submit" disabled={!file || !title || uploading} class="btn-upload">
          {uploading ? t($language, 'uploading') : t($language, 'upload')}
        </button>
        <button type="button" on:click={() => dispatch('close')} class="btn-cancel">
          {t($language, 'cancel')}
        </button>
      </div>
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

  .legal-notice {
    background: rgba(255, 152, 0, 0.15);
    border: 1px solid rgba(255, 152, 0, 0.5);
    border-radius: 8px;
    padding: 1rem;
    margin-bottom: 1.5rem;
  }

  .legal-notice strong {
    color: #ff9800;
    display: block;
    margin-bottom: 0.5rem;
  }

  .legal-notice p {
    margin: 0;
    font-size: 0.85rem;
    color: #ddd;
    line-height: 1.5;
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

  input[type="file"] {
    width: 100%;
    padding: 0.75rem;
    background: #1a1a1a;
    border: 1px solid #444;
    border-radius: 6px;
    color: white;
  }

  small {
    color: #888;
    font-size: 0.875rem;
  }

  .actions {
    display: flex;
    gap: 1rem;
    margin-top: 2rem;
  }

  .btn-upload {
    flex: 1;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 0.75rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 1rem;
  }

  .btn-upload:disabled {
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
