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
    loadAssignments,
    padDisplayName,
    resolveSources,
    saveAssignments,
    type Assignment,
    type Assignments
  } from '$lib/znet/devices';
  import { pads, watchPads } from '$lib/controls/pad-watch';

  export let roomId: string = '';
  export let currentConfig: ControlsConfig;
  /**
   * Whether a local player 2 can actually drive port 2 from here.
   *
   * The profile page leaves it true: there is no room, and the bindings are
   * being set for a future solo game. A room passes what it knows.
   */
  export let localPlayer2Playable = true;
  /**
   * The level the two player headings take, passed straight through.
   *
   * Same reason as the width the doc comment above mentions: this is mounted
   * in two containers, and they do not sit at the same depth in their page's
   * outline. See `headingLevel` in PlayerControls.
   */
  export let headingLevel: 3 | 4 = 4;

  const dispatch = createEventDispatcher<{ saved: { config: ControlsConfig } }>();
  const logger = createLogger('ControlsSettings');

  let workingConfig: ControlsConfig = normaliseControlsConfig(currentConfig);
  let assignments: Assignments = { p1: { keyboard: true, gamepad: 'auto' }, p2: { keyboard: false, gamepad: null } };
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
  /** Long enough that a twelve-button run is one request, short enough to feel instant. */
  const SAVE_DEBOUNCE_MS = 600;
  /** Which player is visible when the container is too narrow for both. */
  let tab: 1 | 2 = 1;

  /**
   * The shared search, for as long as this panel is on screen.
   *
   * The panel used to read the pad list once at mount and then wait for
   * `gamepadconnected`, which is blind twice over: to a pad that announced
   * itself while `/api/user/controls` was still in flight - this panel does not
   * exist until that answers - and to anything the event misses. `pad-watch`
   * polls until it has found something, and says so.
   */
  let stopWatching: (() => void) | null = null;

  onMount(() => {
    assignments = loadAssignments(localStorage);
    // The profile page starts the same watch at navigation; two watchers share
    // one timer, so this is free there and is what covers the pause panel.
    stopWatching = watchPads();
  });

  onDestroy(() => {
    // A pending save must not die with the panel: closing the submenu within
    // the debounce window would otherwise silently drop the last binding, and
    // the last binding is the one the player just made.
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
      void saveConfig();
    }
    stopWatching?.();
    stopWatching = null;
  });

  $: sources = resolveSources(assignments, $pads);
  /** Named, because "controller detected" without a name cannot be checked. */
  $: foundPadName = $pads.length > 0 ? padDisplayName($pads[0].id) || `#${$pads[0].index + 1}` : '';
  $: conflicts = findConflicts(workingConfig, sources);

  /**
   * A player is busy while the *other* one is binding, never while it is.
   *
   * Takes `saving`/`loading`/`capturing` as explicit parameters rather than
   * reading them off the closure. Svelte 4 derives a reactive statement's
   * dependencies from the identifiers written *in that statement*, not from
   * what a called function reads inside itself: both `busy={busyFor(1)}` in
   * the template and a `$: busy1 = busyFor(1)` would compile to one-time
   * initialisation and the exclusion below would never fire again. Naming the
   * state at the call site is what makes the two statements re-run.
   */
  function busyFor(
    player: 1 | 2,
    saving: boolean,
    loading: boolean,
    capturing: 1 | 2 | null
  ): boolean {
    return saving || loading || (capturing !== null && capturing !== player);
  }

  $: busy1 = busyFor(1, isSaving, isLoading, capturingPlayer);
  $: busy2 = busyFor(2, isSaving, isLoading, capturingPlayer);

  function onCapturing(player: 1 | 2, active: boolean) {
    if (active) capturingPlayer = player;
    else if (capturingPlayer === player) capturingPlayer = null;
  }

  function onPlayerChange(player: 1 | 2, controls: PlayerControlsConfig) {
    workingConfig = { ...workingConfig, [player === 1 ? 'p1' : 'p2']: controls };
    scheduleSave();
  }

  /**
   * Bindings persist the moment they are captured, with no button.
   *
   * The device assignment already saved on the spot - it describes this
   * machine and lives in localStorage - while bindings waited for a "save"
   * nothing distinguished visually. The drawing updated under the player's
   * fingers either way, so everything said the change had landed. One panel
   * with two persistence models taught the wrong lesson, and the bindings were
   * the half that quietly did not stick.
   *
   * Debounced, because binding all twelve buttons in a run would otherwise be
   * twelve round trips.
   */
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveConfig();
    }, SAVE_DEBOUNCE_MS);
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
      // The binding stays on screen rather than being quietly reverted: the
      // player made a deliberate choice, and the next capture retries.
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

  <!-- The one thing nothing used to say. A browser does not admit a gamepad
       exists until one of its buttons has been pressed, so a controller plugged
       in and left alone is invisible here - and the player had no way to know
       that pressing anything would reveal it. -->
  <p class="pad-search" class:found={$pads.length > 0}>
    {#if $pads.length > 0}
      🎮 {t($language, 'controllerFound', { name: foundPadName })}
    {:else}
      {t($language, 'lookingForController')}
    {/if}
  </p>

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
        {headingLevel}
        player={1}
        controls={workingConfig.p1}
        assignment={assignments.p1}
        sources={sources.p1}
        pads={$pads}
        conflicts={conflicts.p1}
        allowAuto={true}
        busy={busy1}
        on:change={(e) => onPlayerChange(1, e.detail.controls)}
        on:assign={(e) => onAssign(1, e.detail.assignment)}
        on:capturing={(e) => onCapturing(1, e.detail.active)}
      />
    </div>
    <div class="column" class:hidden-narrow={tab !== 2}>
      <PlayerControls
        {headingLevel}
        player={2}
        controls={workingConfig.p2}
        assignment={assignments.p2}
        sources={sources.p2}
        pads={$pads}
        conflicts={conflicts.p2}
        allowAuto={false}
        playable={localPlayer2Playable}
        busy={busy2}
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
    <span class="save-state" aria-live="polite">
      {isSaving ? t($language, 'saving') : t($language, 'savedAutomatically')}
    </span>
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

  .pad-search {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    color: #8b8ba3;
  }

  .pad-search.found {
    color: #7fd18a;
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

  .save-state {
    align-self: center;
    font-size: 0.8rem;
    color: #999;
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
