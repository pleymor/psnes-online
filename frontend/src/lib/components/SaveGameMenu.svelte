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
  import { captureShot, captureState } from '$lib/saves/capture';
  import { notifications } from '$lib/services/notification';

  export let roomId: string;
  export let gameId: string;
  /** Needs `saveState()`; `getCanvas()` is optional and only costs a thumbnail. */
  export let emulator: any = null;

  const logger = createLogger('SaveGameMenu');
  const dispatch = createEventDispatcher();

  let grid: SaveGrid;
  let busy = false;
  let pendingOverwrite: SaveSummary | null = null;

  async function write(saveId: string | undefined, name: string) {
    busy = true;
    const screenshot = captureShot(emulator);
    const saveData = await captureState(emulator);

    $socket?.emit('game:save', { roomId, saveId, name, saveData, screenshot });

    // Straight to the toast store. These used to be dispatched to a parent
    // that never listened, so "save created" has never actually been shown.
    const onSaved = () => {
      busy = false;
      notifications.show(t($language, 'saveCreated'), 'success');
      grid?.reload();
      $socket?.off('error', onError);
    };

    const onError = (error: unknown) => {
      busy = false;
      logger.error('Error saving:', error);
      notifications.show(t($language, 'failedToSave'), 'error');
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
