<script lang="ts">
  /**
   * Choosing a save to load.
   *
   * This menu only loads. Overwriting lives in the save menu, so that a
   * mis-click here cannot destroy anything - the two used to share one screen
   * and one list of buttons.
   *
   * One exception, and it destroys nothing either: a cartridge save the sync
   * kept instead of overwriting it (#71) is not a savestate, so it is not
   * loaded - it is restored, which swaps it with the current one. The room
   * that can do that provides `RESTORE_SRAM` in its context; a room that
   * cannot (lockstep, where both machines must hold the same battery) leaves
   * it out, and the tile says so instead of pretending.
   */
  import { createEventDispatcher, getContext } from 'svelte';
  import SaveGrid from './SaveGrid.svelte';
  import { socket } from '$lib/api/socket';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import type { SaveSummary } from '$lib/saves/api';
  import { notifications } from '$lib/services/notification';
  import { RESTORE_SRAM, type RestoreSram } from '$lib/saves/restore';

  export let roomId: string;
  export let gameId: string;

  const logger = createLogger('LoadSavesMenu');
  const dispatch = createEventDispatcher();
  const restore = getContext<RestoreSram | undefined>(RESTORE_SRAM);

  let busy = false;

  async function restoreKept(save: SaveSummary) {
    if (!restore) {
      notifications.show(t($language, 'failedToRestoreSram'), 'error');
      return;
    }
    if (!confirm(t($language, 'restoreSramConfirm'))) return;
    busy = true;
    const ok = await restore(save.id);
    busy = false;
    notifications.show(t($language, ok ? 'sramRestored' : 'failedToRestoreSram'), ok ? 'success' : 'error');
    if (ok) dispatch('close');
  }

  function loadSave(save: SaveSummary) {
    if (save.kind === 'sram') {
      void restoreKept(save);
      return;
    }
    busy = true;
    $socket?.emit('game:load', { roomId, saveId: save.id });

    // Straight to the toast store, for the same reason as the save menu: the
    // dispatched events reached a parent that never listened for them.
    const onLoaded = () => {
      busy = false;
      notifications.show(t($language, 'saveLoaded'), 'success');
      dispatch('close');
      $socket?.off('error', onError);
    };

    const onError = (error: unknown) => {
      busy = false;
      logger.error('Error loading save:', error);
      notifications.show(t($language, 'failedToLoad'), 'error');
      $socket?.off('game:loaded', onLoaded);
    };

    $socket?.once('game:loaded', onLoaded);
    $socket?.once('error', onError);
  }
</script>

<div class="menu">
  <h3>{t($language, 'loadGame')}</h3>
  <SaveGrid
    {gameId}
    {busy}
    kinds={restore ? ['state', 'sram'] : ['state']}
    actionLabel={t($language, 'loadState')}
    sramActionLabel={t($language, 'restoreSram')}
    on:select={(e) => loadSave(e.detail)}
  />
</div>

<style>
  .menu {
    background: #1a1a1a;
    border-radius: 8px;
    padding: 1.5rem;
  }

  h3 {
    margin: 0 0 1.25rem;
    font-size: 1.25rem;
    color: white;
  }
</style>
