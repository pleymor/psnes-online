<script lang="ts">
  /**
   * The shell: two players, the conflicts between them, saving.
   *
   * Everything about a single player lives in PlayerControls, and everything
   * about a single button in SnesPad. What is left here is what can belong
   * to neither: the config of both players, the conflicts that cross between
   * them, and the round trip to the server.
   *
   * Mounted in two containers of very different widths - a profile page
   * section and the 20rem pause panel - so it asks its own width rather than
   * the window's.
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import ConfirmModal from './ConfirmModal.svelte';
  import PlayerControls from './PlayerControls.svelte';
  import { createLogger } from '$lib/utils/logger';
  import {
    findConflicts,
    normaliseControlsConfig,
    type ControlsConfig,
    type PlayerControls as PlayerControlsConfig
  } from '$lib/controls/binding';
  import {
    connectedPads,
    loadAssignments,
    resolveSources,
    saveAssignments,
    type Assignment,
    type Assignments,
    type PadInfo
  } from '$lib/znet/devices';

  export let roomId: string = '';
  export let currentConfig: ControlsConfig;

  const dispatch = createEventDispatcher<{ saved: { config: ControlsConfig } }>();
  const logger = createLogger('ControlsSettings');

  let workingConfig: ControlsConfig = normaliseControlsConfig(currentConfig);
  let assignments: Assignments = { p1: { keyboard: true, gamepad: 'auto' }, p2: { keyboard: false, gamepad: null } };
  let pads: PadInfo[] = [];
  let isSaving = false;
  let isLoading = false;
  let errorMessage = '';
  let showResetConfirm = false;
  /**
   * Which player is mid-capture, not merely whether someone is.
   *
   * Each PlayerControls mounts its own `svelte:window on:keydown`, so two
   * simultaneous captures would both consume the same keypress and write it
   * into both players' configs. Knowing *which* player is capturing lets the
   * other one be made busy, which is what keeps the two apart.
   */
  let capturingPlayer: 1 | 2 | null = null;
  /** Which player is visible when the container is too narrow for both. */
  let tab: 1 | 2 = 1;

  function refreshPads() {
    pads = connectedPads();
  }

  onMount(() => {
    assignments = loadAssignments(localStorage);
    refreshPads();
    window.addEventListener('gamepadconnected', refreshPads);
    window.addEventListener('gamepaddisconnected', refreshPads);
  });

  onDestroy(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('gamepadconnected', refreshPads);
    window.removeEventListener('gamepaddisconnected', refreshPads);
  });

  $: sources = resolveSources(assignments, pads);
  $: conflicts = findConflicts(workingConfig, sources);
  $: hasChanges = JSON.stringify(workingConfig) !== JSON.stringify(normaliseControlsConfig(currentConfig));
  $: canSave = hasChanges && conflicts.count === 0 && capturingPlayer === null;

  /** A player is busy while the *other* one is binding, never while it is. */
  function busyFor(player: 1 | 2): boolean {
    return isSaving || isLoading || (capturingPlayer !== null && capturingPlayer !== player);
  }

  function onCapturing(player: 1 | 2, active: boolean) {
    if (active) capturingPlayer = player;
    else if (capturingPlayer === player) capturingPlayer = null;
  }

  function onPlayerChange(player: 1 | 2, controls: PlayerControlsConfig) {
    workingConfig = { ...workingConfig, [player === 1 ? 'p1' : 'p2']: controls };
  }

  function onAssign(player: 1 | 2, assignment: Assignment) {
    assignments = { ...assignments, [player === 1 ? 'p1' : 'p2']: assignment };
    // Written immediately: the assignment lives on this machine, not in the
    // account config, so it does not wait for the "save" button.
    saveAssignments(localStorage, assignments);
  }

  async function saveConfig() {
    isSaving = true;
    errorMessage = '';
    try {
      const response = await fetch('/api/user/controls', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(workingConfig)
      });
      if (!response.ok) throw new Error('Failed to save controls');

      // The room only ever carries one mapping per member: P1's.
      if (roomId && $socket) {
        $socket.emit('room:updateKeyConfig', { roomId, keyConfig: workingConfig.p1.keys });
      }

      currentConfig = workingConfig;
      dispatch('saved', { config: workingConfig });
    } catch (error) {
      logger.error('Error saving controls:', error);
      errorMessage = t($language, 'failedToSaveControls');
    } finally {
      isSaving = false;
    }
  }

  async function handleResetConfirm() {
    showResetConfirm = false;
    isLoading = true;
    errorMessage = '';
    try {
      const response = await fetch('/api/user/controls/reset', {
        method: 'POST',
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to reset controls');

      const data = await response.json();
      workingConfig = normaliseControlsConfig(data.config);
      if (roomId && $socket) {
        $socket.emit('room:updateKeyConfig', { roomId, keyConfig: workingConfig.p1.keys });
      }
      currentConfig = workingConfig;
      dispatch('saved', { config: workingConfig });
    } catch (error) {
      logger.error('Error resetting controls:', error);
      errorMessage = t($language, 'failedToResetControls');
    } finally {
      isLoading = false;
    }
  }
</script>

<div class="controls-settings">
  <p class="lead">{t($language, 'twoPlayerControlsHint')}</p>

  <!-- Tabs only matter below the threshold; the CSS hides them at full
       width, where the two columns fit side by side. -->
  <div class="tabs">
    <button type="button" class:on={tab === 1} on:click={() => (tab = 1)}>
      {t($language, 'player1')}
    </button>
    <button type="button" class:on={tab === 2} on:click={() => (tab = 2)}>
      {t($language, 'player2')}
    </button>
  </div>

  <div class="players">
    <div class="column" class:hidden-narrow={tab !== 1}>
      <PlayerControls
        player={1}
        controls={workingConfig.p1}
        assignment={assignments.p1}
        sources={sources.p1}
        {pads}
        conflicts={conflicts.p1}
        allowAuto={true}
        busy={busyFor(1)}
        on:change={(e) => onPlayerChange(1, e.detail.controls)}
        on:assign={(e) => onAssign(1, e.detail.assignment)}
        on:capturing={(e) => onCapturing(1, e.detail.active)}
      />
    </div>
    <div class="column" class:hidden-narrow={tab !== 2}>
      <PlayerControls
        player={2}
        controls={workingConfig.p2}
        assignment={assignments.p2}
        sources={sources.p2}
        {pads}
        conflicts={conflicts.p2}
        allowAuto={false}
        busy={busyFor(2)}
        on:change={(e) => onPlayerChange(2, e.detail.controls)}
        on:assign={(e) => onAssign(2, e.detail.assignment)}
        on:capturing={(e) => onCapturing(2, e.detail.active)}
      />
    </div>
  </div>

  {#if conflicts.count > 0}
    <div class="conflict-warning">
      ⚠️ {t($language, 'conflictingAssignments', { count: conflicts.count })}
    </div>
  {/if}

  {#if errorMessage}
    <div class="error-message">{errorMessage}</div>
  {/if}

  <div class="actions">
    <button
      class="btn-reset"
      on:click={() => (showResetConfirm = true)}
      disabled={isLoading || isSaving || capturingPlayer !== null}
    >
      {isLoading ? t($language, 'resetting') : t($language, 'resetToDefaults')}
    </button>
    <button class="btn-save" on:click={saveConfig} disabled={!canSave || isSaving}>
      {isSaving ? t($language, 'saving') : t($language, 'saveChanges')}
    </button>
  </div>
</div>

<style>
  .controls-settings {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    /* Mounted in a wide page section and in the 20rem pause panel: it must
       respond to its own width, not the window's. Safe here - nothing is
       absolutely positioned, and the confirm modal is a sibling, not a
       descendant. */
    container-type: inline-size;
  }

  .lead {
    margin: 0;
    font-size: 0.85rem;
    color: #aaa;
  }

  .players {
    display: grid;
    /* minmax(0, 1fr), not a bare 1fr: a bare 1fr means minmax(auto, 1fr),
       and that auto floor lets an SVG push its column wide. */
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 2rem;
  }

  .column {
    min-width: 0;
  }

  .tabs {
    display: none;
    gap: 0.25rem;
  }

  .tabs button,
  .actions button {
    background: #333;
    color: #eee;
    border: 1px solid #555;
    border-radius: 6px;
    padding: 0.45rem 0.9rem;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .tabs button.on {
    background: #1976d2;
    border-color: #1976d2;
    font-weight: 600;
  }

  /* Two 520-unit drawings need roughly twice ~22rem. Below that, one player
     at a time, or the labels on the buttons become unreadable - and that is
     the pause panel's case. */
  @container (max-width: 46rem) {
    .players {
      grid-template-columns: minmax(0, 1fr);
    }

    .tabs {
      display: flex;
    }

    .column.hidden-narrow {
      display: none;
    }
  }

  .conflict-warning {
    background: rgba(255, 152, 0, 0.2);
    border: 2px solid #ff9800;
    color: #ffb74d;
    padding: 0.75rem;
    border-radius: 6px;
    text-align: center;
    font-size: 0.9rem;
  }

  .error-message {
    background: #d32f2f;
    color: white;
    padding: 0.75rem;
    border-radius: 6px;
    text-align: center;
    font-size: 0.9rem;
  }

  .actions {
    display: flex;
    gap: 1rem;
  }

  .actions button {
    flex: 1;
    padding: 0.8rem;
    font-weight: 500;
  }

  .btn-save {
    background: #4caf50;
    border-color: #4caf50;
    color: white;
  }

  .actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>

{#if showResetConfirm}
  <ConfirmModal
    title={t($language, 'resetControls')}
    message={t($language, 'confirmResetControls')}
    confirmText={t($language, 'reset')}
    cancelText={t($language, 'cancel')}
    danger={true}
    on:confirm={handleResetConfirm}
    on:cancel={() => (showResetConfirm = false)}
  />
{/if}
