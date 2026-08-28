<script lang="ts">
  /**
   * Reconnects a library entry to a file, for games added before ROMs stayed local.
   *
   * Those entries were created from a Drive file the server has no copy of and
   * no checksum for, so nothing can resolve them to a file on disk. Rather than
   * delete them - they carry the player's saves - this asks once for the ROM and
   * records what it actually contains.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { designateFile } from '$lib/roms/provider';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('LinkRom');
  const dispatch = createEventDispatcher<{ close: void; linked: string }>();

  export let gameId: string;
  export let title = '';

  const ACCEPT = '.smc,.sfc,.fig,.swc,.mgd,.zip';

  let fileInput: HTMLInputElement;
  let busy = false;
  let error = '';

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) dispatch('close');
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  async function onFileChosen(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;

    busy = true;
    error = '';
    try {
      // Désigner, pas seulement hacher. Une entrée sans checksum reste visible
      // dans la grille parce qu'elle est réparable ; dès que la réparation
      // réussit elle en acquiert un, et si cet appareil n'a pas gardé les octets
      // du fichier qu'on vient de lui montrer, le jeu disparaît. Le joueur ferait
      // ce que l'interface lui demande et serait puni par une disparition.
      const { checksum } = await designateFile(file);
      const res = await fetch(`/api/games/${gameId}/checksum`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checksum })
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      dispatch('linked', checksum);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error('Could not link the ROM', err);
    } finally {
      busy = false;
    }
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="backdrop" role="presentation" on:click={() => !busy && dispatch('close')}>
  <div class="modal" role="dialog" aria-modal="true" on:click|stopPropagation>
    <h2>{t($language, 'linkRomTitle')} {title}</h2>
    <p class="explain">{t($language, 'linkRomExplain')}</p>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <input
      bind:this={fileInput}
      type="file"
      accept={ACCEPT}
      class="hidden-input"
      on:change={onFileChosen}
    />

    <div class="actions">
      <button class="secondary" on:click={() => dispatch('close')} disabled={busy}>
        {t($language, 'cancel')}
      </button>
      <button class="primary" on:click={() => fileInput.click()} disabled={busy}>
        {busy ? t($language, 'loading') : t($language, 'chooseOneRom')}
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
    max-width: 440px;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  h2 {
    margin: 0;
    font-size: 1.15rem;
    color: #fff;
  }

  .explain {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.5;
    color: #8b8ba3;
  }

  .error {
    margin: 0;
    color: #ff8f8f;
    font-size: 0.85rem;
  }

  .hidden-input {
    display: none;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
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
