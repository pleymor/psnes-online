<script lang="ts">
  /**
   * Writing a save: a new one, or over an existing one.
   *
   * This menu cannot load. Picking an existing save overwrites it, which is
   * why it asks first - a list where one click loads and another destroys is
   * how the two get confused.
   *
   * There is no slot picker. The server assigns the number, so a new save can
   * always be made and nothing has to be chosen to make one.
   */
  import { createEventDispatcher } from 'svelte';
  import SaveGrid from './SaveGrid.svelte';
  import ConfirmModal from './ConfirmModal.svelte';
  import { socket } from '$lib/api/socket';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import { autoSaveName, type SaveSummary } from '$lib/saves/api';
  import { captureThumbnail } from '$lib/saves/thumbnail';

  export let roomId: string;
  export let gameId: string;
  /** Needs `saveState()`; `getCanvas()` is optional and only costs a thumbnail. */
  export let emulator: any = null;

  const logger = createLogger('SaveGameMenu');
  const dispatch = createEventDispatcher();

  let grid: SaveGrid;
  let busy = false;
  let pendingOverwrite: SaveSummary | null = null;

  /**
   * Base64 for buffers of any size.
   *
   * `String.fromCharCode(...bytes)` spreads one argument per byte, which blows
   * the call stack somewhere around 100k. A real savestate is over 800KB.
   */
  function toBase64(bytes: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function captureState(): Promise<string | undefined> {
    if (!emulator) return undefined;
    try {
      const result = await emulator.saveState();
      const blob = result?.state ?? result;
      if (blob instanceof Blob) {
        return toBase64(new Uint8Array(await blob.arrayBuffer()));
      }
      if (result instanceof Uint8Array) return toBase64(result);
    } catch (error) {
      logger.error('Failed to capture emulator state:', error);
    }
    return undefined;
  }

  /** A save without a picture is fine; a save that failed because of one is not. */
  function captureShot(): string | undefined {
    try {
      const canvas = emulator?.getCanvas?.();
      return canvas ? captureThumbnail(canvas) ?? undefined : undefined;
    } catch (error) {
      logger.error('Failed to capture thumbnail:', error);
      return undefined;
    }
  }

  async function write(saveId: string | undefined, name: string) {
    busy = true;
    const screenshot = captureShot();
    const saveData = await captureState();

    $socket?.emit('game:save', { roomId, saveId, name, saveData, screenshot });

    const onSaved = () => {
      busy = false;
      dispatch('notification', { message: t($language, 'saveCreated'), type: 'success' });
      grid?.reload();
      $socket?.off('error', onError);
    };

    const onError = (error: unknown) => {
      busy = false;
      logger.error('Error saving:', error);
      dispatch('notification', { message: t($language, 'failedToSave'), type: 'error' });
      $socket?.off('game:saved', onSaved);
    };

    $socket?.once('game:saved', onSaved);
    $socket?.once('error', onError);
  }

  function createNew() {
    write(undefined, autoSaveName($language));
  }

  function confirmOverwrite() {
    const target = pendingOverwrite;
    pendingOverwrite = null;
    if (target) write(target.id, target.name);
  }
</script>

<div class="menu">
  <div class="header">
    <h3>{t($language, 'saveGame')}</h3>
    <button class="btn-new" disabled={busy} on:click={createNew}>
      + {t($language, 'newSave')}
    </button>
  </div>

  <p class="hint">{t($language, 'overwriteHint')}</p>

  <SaveGrid
    bind:this={grid}
    {gameId}
    {busy}
    actionLabel={t($language, 'overwrite')}
    on:select={(e) => (pendingOverwrite = e.detail)}
  />
</div>

{#if pendingOverwrite}
  <ConfirmModal
    title={t($language, 'overwriteSaveTitle')}
    message={t($language, 'confirmOverwriteSave').replace('{name}', pendingOverwrite.name)}
    confirmText={t($language, 'overwrite')}
    on:confirm={confirmOverwrite}
    on:cancel={() => (pendingOverwrite = null)}
  />
{/if}

<style>
  .menu {
    /* Measured against its own width, not the viewport's: this menu lives in a
       20rem side panel on a wide screen and in a wide card on a narrow one, so
       a media query would get it backwards. */
    container-type: inline-size;
    background: #1a1a1a;
    border-radius: 8px;
    padding: 1.5rem;
  }

  .header {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  /* Room for the title and the button side by side. Below this they stack, and
     the button spans the width rather than being squeezed against the title. */
  @container (min-width: 26rem) {
    .header {
      flex-direction: row;
      justify-content: space-between;
      align-items: center;
    }
  }

  h3 {
    margin: 0;
    font-size: 1.25rem;
    color: white;
  }

  .btn-new {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.875rem;
  }

  .btn-new:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .hint {
    margin: 0 0 1rem;
    color: #888;
    font-size: 0.8125rem;
  }
</style>
