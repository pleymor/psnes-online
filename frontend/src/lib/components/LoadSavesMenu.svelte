<script lang="ts">
  /**
   * Choosing a save to load.
   *
   * This menu only loads. Overwriting lives in the save menu, so that a
   * mis-click here cannot destroy anything - the two used to share one screen
   * and one list of buttons.
   */
  import { createEventDispatcher } from 'svelte';
  import SaveGrid from './SaveGrid.svelte';
  import { socket } from '$lib/api/socket';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';
  import type { SaveSummary } from '$lib/saves/api';

  export let roomId: string;
  export let gameId: string;

  const logger = createLogger('LoadSavesMenu');
  const dispatch = createEventDispatcher();

  let busy = false;

  function loadSave(save: SaveSummary) {
    busy = true;
    $socket?.emit('game:load', { roomId, saveId: save.id });

    const onLoaded = () => {
      busy = false;
      dispatch('notification', { message: t($language, 'saveLoaded'), type: 'success' });
      dispatch('close');
      $socket?.off('error', onError);
    };

    const onError = (error: unknown) => {
      busy = false;
      logger.error('Error loading save:', error);
      dispatch('notification', { message: t($language, 'failedToLoad'), type: 'error' });
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
    actionLabel={t($language, 'loadState')}
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
