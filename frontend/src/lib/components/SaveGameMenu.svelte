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
   *
   * The same menu offline (a game outside any room): `shelf` and `write` then
   * point at this device's saves instead of the server. Online, each save is
   * also kept on this device first (`saves/offline-copy.ts`), so that it is
   * still there once the network is gone.
   */
  import { createEventDispatcher } from 'svelte';
  import SaveGrid from './SaveGrid.svelte';
  import ConfirmModal from './ConfirmModal.svelte';
  import { socket } from '$lib/api/socket';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { autoSaveName, type SaveSummary } from '$lib/saves/api';
  import { captureShot, captureState } from '$lib/saves/capture';
  import { mirrorOf, writeThroughSocket } from '$lib/saves/offline-copy';
  import type { DeviceSaveActions, SaveShelf } from '$lib/saves/shelf';
  import { notifications } from '$lib/services/notification';

  export let roomId: string;
  export let gameId: string;
  /** Needs `saveState()`; `getCanvas()` is optional and only costs a thumbnail. */
  export let emulator: any = null;
  /** The cartridge, so the save can be kept on this device too. */
  export let gameCrc32: string | null = null;
  /** Offline: this device's saves, in place of the server's. */
  export let shelf: SaveShelf | null = null;
  export let deviceWrite: DeviceSaveActions['write'] | null = null;

  const dispatch = createEventDispatcher();

  let grid: SaveGrid;
  let busy = false;
  let pendingOverwrite: SaveSummary | null = null;

  async function write(target: SaveSummary | undefined, name: string) {
    busy = true;
    if (deviceWrite) {
      const ok = await deviceWrite(target, name);
      busy = false;
      notifications.show(t($language, ok ? 'saveCreated' : 'failedToSave'), ok ? 'success' : 'error');
      if (ok) grid?.reload();
      return;
    }

    const screenshot = captureShot(emulator);
    const saveData = await captureState(emulator);

    // Straight to the toast store. These used to be dispatched to a parent
    // that never listened, so "save created" has never actually been shown.
    const result = await writeThroughSocket({
      socket: $socket,
      roomId,
      target: target ? { id: target.id, name: target.name } : null,
      name,
      saveData,
      screenshot,
      mirror: mirrorOf(gameCrc32)
    });
    busy = false;
    if (!result.ok) {
      notifications.show(t($language, 'failedToSave'), 'error');
      return;
    }
    notifications.show(t($language, result.queued ? 'savedOnDevice' : 'saveCreated'), 'success');
    grid?.reload();
  }

  function createNew() {
    write(undefined, autoSaveName($language));
  }

  function confirmOverwrite() {
    const target = pendingOverwrite;
    pendingOverwrite = null;
    if (target) write(target, target.name);
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
    {shelf}
    withLegacy={false}
    kinds={['state']}
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
    background: var(--go);
    border-color: var(--go-deep);
    color: #ffffff;
    font-size: 0.95rem;
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
