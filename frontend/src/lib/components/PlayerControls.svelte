<script lang="ts">
  /**
   * One player: their sources, the table they are editing, their drawing.
   *
   * Two distinct questions live here, and conflating them would be the
   * mistake: "which device does this player hold" (the assignment, which
   * also decides whether they play at all) and "which table am I editing
   * right now" (keyboard or pad, two independent tables and both live).
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { language, type Language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { CaptureGate } from '$lib/controls/capture-gate';
  import SnesPad from './SnesPad.svelte';
  import {
    BUTTONS,
    STANDARD_PAD,
    describeCode,
    isPadCode,
    shortLabel,
    type Button,
    type ConflictMap,
    type InputSources,
    type PadSelection,
    type PlayerControls as PlayerControlsConfig
  } from '$lib/controls/binding';
  import {
    connectedPads,
    isPlayerActive,
    padDisplayName,
    type Assignment,
    type PadInfo
  } from '$lib/znet/devices';

  export let player: 1 | 2;
  export let controls: PlayerControlsConfig;
  export let assignment: Assignment;
  export let pads: PadInfo[] = [];
  /**
   * This player's already-resolved sources (`resolveSources`, devices.ts).
   * Not derived locally: this component only ever sees its own assignment,
   * and re-deriving "which pads are mine" from that alone can't exclude the
   * pads the other player has explicitly claimed - only the parent, which
   * holds both assignments, can resolve that correctly.
   */
  export let sources: InputSources;
  export let conflicts: { keys: ConflictMap; pad: ConflictMap };
  /** `'auto'` is offered only to P1: for a second player it is a trap. */
  export let allowAuto = false;
  export let busy = false;

  const dispatch = createEventDispatcher<{
    change: { controls: PlayerControlsConfig };
    assign: { assignment: Assignment };
    capturing: { active: boolean };
  }>();

  /** Which of the two tables the drawing shows and captures into. */
  let editing: 'keys' | 'pad' = 'keys';
  let capturing: Button | null = null;
  let sequence = -1;
  let controlsBeforeSequence: PlayerControlsConfig | null = null;
  let detecting = false;
  let notice = '';
  let pollTimer: number | null = null;
  const gate = new CaptureGate();

  /** The order a thumb takes going around the pad, as in the old grid. */
  const BIND_ORDER: Button[] = [
    'up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'
  ];

  $: buttonLabels = {
    up: t($language, 'dPadUp'), down: t($language, 'dPadDown'),
    left: t($language, 'dPadLeft'), right: t($language, 'dPadRight'),
    a: t($language, 'aButton'), b: t($language, 'bButton'),
    x: t($language, 'xButton'), y: t($language, 'yButton'),
    l: t($language, 'lShoulder'), r: t($language, 'rShoulder'),
    start: t($language, 'startButton'), select: t($language, 'selectButton')
  } as Record<Button, string>;

  $: hasPad = assignment.gamepad !== null;
  // A player with no pad has nothing to edit on the pad side. The selector
  // would otherwise sit on a table nobody reads.
  $: if (!hasPad && editing === 'pad') editing = 'keys';

  $: bindings = Object.fromEntries(
    BUTTONS.map((button) => [
      button,
      editing === 'keys' ? [controls.keys[button]].filter(Boolean) : controls.pad[button]
    ])
  ) as Record<Button, string[]>;

  $: activeConflicts = new Set(conflicts[editing].keys());

  /**
   * The long form of a binding, for the drawing's aria-label.
   *
   * Takes `playerControls`/`editingTable`/`lang` as explicit parameters
   * rather than reading `controls`/`editing`/`$language` off the closure:
   * Svelte's compiler derives a reactive statement's dependencies from the
   * identifiers it can see written *in that statement*, not from what a
   * called function reads internally. A call site of `describe(button)`
   * alone would give the `$: descriptions = …` statement below an empty
   * dependency set, and it would run once at mount and never again - the bug
   * this shape avoids.
   */
  function describe(
    button: Button,
    playerControls: PlayerControlsConfig,
    editingTable: 'keys' | 'pad',
    lang: Language
  ): string {
    const codes = editingTable === 'keys' ? [playerControls.keys[button]] : playerControls.pad[button];
    const first = codes.find(Boolean);
    if (!first) return t(lang, 'unboundBinding');
    const described = describeCode(first);
    if (described.kind === 'keyboard') {
      return t(lang, 'boundToKey', { key: shortLabel(described.code) });
    }
    if (described.kind === 'padButton') {
      return t(lang, 'boundToPadButton', { index: described.index });
    }
    if (described.kind === 'padAxis') {
      return t(lang, 'boundToPadAxis', {
        index: described.index,
        dir: described.dir === 'minus' ? '−' : '+'
      });
    }
    return t(lang, 'unboundBinding');
  }

  // `controls`, `editing` and `$language` appear literally here so the
  // statement actually recomputes on rebind, table switch and language
  // change - see the note on `describe` above.
  $: descriptions = Object.fromEntries(
    BUTTONS.map((button) => [button, describe(button, controls, editing, $language)])
  ) as Record<Button, string>;

  /* ------------------------------------------------------------- capture */

  function startCapture(button: Button) {
    capturing = button;
    notice = '';
    gate.reset();
    startPolling();
    dispatch('capturing', { active: true });
  }

  function stopCapture() {
    capturing = null;
    sequence = -1;
    controlsBeforeSequence = null;
    dispatch('capturing', { active: false });
  }

  function startSequence() {
    controlsBeforeSequence = { keys: { ...controls.keys }, pad: { ...controls.pad } };
    sequence = 0;
    startCapture(BIND_ORDER[0]);
  }

  function advance() {
    sequence += 1;
    if (sequence >= BIND_ORDER.length) stopCapture();
    else capturing = BIND_ORDER[sequence];
  }

  /**
   * Cancelling restores what was there before.
   *
   * Keeping the bindings made so far would leave the pad half-rewritten in a
   * state the player did not choose and cannot see the shape of.
   */
  function cancelSequence() {
    if (controlsBeforeSequence) controls = controlsBeforeSequence;
    dispatch('change', { controls });
    stopCapture();
  }

  /** Writes a binding, and advances if there is somewhere to advance to. */
  function apply(code: string) {
    if (!capturing) return;
    const next = { keys: { ...controls.keys }, pad: { ...controls.pad } };
    // A capture replaces: this is the predictable behaviour, and the only
    // lists with more than one code are the standard mapping's.
    if (isPadCode(code)) next.pad[capturing] = [code];
    else next.keys[capturing] = code;
    controls = next;
    dispatch('change', { controls });

    if (sequence >= 0) advance();
    else stopCapture();
  }

  /**
   * What is held on the keyboard, to light up the drawing outside capture.
   *
   * Same service as polling the pads, and for the same reason: the player
   * presses, they see their button light up, they know their binding works.
   */
  let heldKeys = new Set<string>();

  function trackKey(code: string, down: boolean) {
    const next = new Set(heldKeys);
    if (down) next.add(code);
    else next.delete(code);
    heldKeys = next;
  }

  function handleKeyup(event: KeyboardEvent) {
    trackKey(event.code, false);
  }

  function handleBlur() {
    heldKeys = new Set();
  }

  function handleKeydown(event: KeyboardEvent) {
    // Before any early return, and without preventDefault: tracking keys
    // must not prevent anything when no capture is in progress.
    trackKey(event.code, true);

    if (detecting && event.code === 'Escape') {
      stopDetecting(t($language, 'detectCancelled'));
      return;
    }
    if (!capturing) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.code === 'Escape') {
      if (sequence >= 0) cancelSequence();
      else stopCapture();
      return;
    }
    // Leave this button as it is and move to the next: without this, a
    // player who wants nothing on L and R has to invent a binding or throw
    // away the whole sequence.
    if (sequence >= 0 && event.code === 'Tab') {
      advance();
      return;
    }
    // The keyboard can only write into the keyboard table.
    if (editing !== 'keys') return;

    const code = gate.keydown(event);
    if (code) apply(code);
  }

  /* --------------------------------------------------------- pad polling */

  /**
   * Polls this player's pads, for three uses: capturing a binding, detecting
   * which pad belongs to them, and lighting up the drawing live - the last
   * being what tells them they are holding the right one.
   */
  let pressedCodes: string[] = [];

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(poll, 50);
  }

  function stopPolling() {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
    pressedCodes = [];
  }

  function poll() {
    // Detection is the one case with no resolved `sources` to read yet: the
    // pad isn't assigned, so every pad has to be listened to. Everywhere
    // else, `sources.pads` (resolved once by the parent from both players'
    // assignments) is the only correct answer - see the note on the
    // `sources` prop above.
    const mine: PadSelection = detecting ? 'all' : sources.pads;
    const allPads = navigator.getGamepads();
    const active: string[] = [];
    let source: number | null = null;

    for (const pad of connectedPads()) {
      if (mine !== 'all' && !mine.includes(pad.index)) continue;
      const live = allPads[pad.index];
      if (!live) continue;
      for (let i = 0; i < live.buttons.length; i++) {
        if (live.buttons[i]?.pressed) {
          active.push(`PadButton${i}`);
          source ??= pad.index;
        }
      }
      for (let i = 0; i < live.axes.length; i++) {
        const value = live.axes[i];
        if (Math.abs(value) > 0.5) {
          active.push(`PadAxis${i}${value > 0 ? 'Plus' : 'Minus'}`);
          source ??= pad.index;
        }
      }
    }

    pressedCodes = active;

    if (detecting) {
      if (source === null) return;
      const pad = pads.find((p) => p.index === source);
      if (pad) {
        assignment = { ...assignment, gamepad: { id: pad.id, index: pad.index } };
        dispatch('assign', { assignment });
      }
      stopDetecting('');
      return;
    }

    if (!capturing || editing !== 'pad') return;
    const captured = gate.tick(active);
    if (captured) apply(captured);
  }

  /** The SNES buttons lit up right now, in the table being shown. */
  $: pressed = new Set(
    BUTTONS.filter((button) =>
      editing === 'pad'
        ? controls.pad[button].some((code) => pressedCodes.includes(code))
        : heldKeys.has(controls.keys[button])
    )
  );

  /* ------------------------------------------------------------ detection */

  function startDetecting() {
    detecting = true;
    notice = t($language, 'pressButtonOnController', { player });
    gate.reset();
    startPolling();
  }

  function stopDetecting(message: string) {
    detecting = false;
    notice = message;
    if (!capturing) stopPolling();
  }

  /* -------------------------------------------------------- assignment */

  function setKeyboard(on: boolean) {
    assignment = { ...assignment, keyboard: on };
    dispatch('assign', { assignment });
  }

  function setGamepad(value: string) {
    const gamepad =
      value === 'none' ? null : value === 'auto' ? 'auto' : padFromValue(value);
    assignment = { ...assignment, gamepad };
    dispatch('assign', { assignment });
  }

  function padFromValue(value: string) {
    const index = Number(value);
    const pad = pads.find((p) => p.index === index);
    return pad ? { id: pad.id, index: pad.index } : null;
  }

  $: gamepadValue =
    assignment.gamepad === null
      ? 'none'
      : assignment.gamepad === 'auto'
        ? 'auto'
        : String(assignment.gamepad.index);

  function resetPadToStandard() {
    controls = { keys: { ...controls.keys }, pad: { ...STANDARD_PAD } };
    dispatch('change', { controls });
  }

  // The panel can be closed mid-capture - the pause menu is one click away -
  // and polling would otherwise run for the life of the page.
  onDestroy(stopPolling);

  // The drawing must light up even outside capture: that is what lets a
  // player check they are holding the right controller.
  $: if (editing === 'pad' && hasPad) startPolling();
  $: if (editing !== 'pad' && !capturing && !detecting) stopPolling();
</script>

<svelte:window on:keydown={handleKeydown} on:keyup={handleKeyup} on:blur={handleBlur} />

<section class="player">
  <header>
    <h4>{t($language, player === 1 ? 'player1' : 'player2')}</h4>

    <div class="sources" role="group" aria-label={t($language, 'inputSources')}>
      <label>
        <input
          type="checkbox"
          checked={assignment.keyboard}
          disabled={busy}
          on:change={(e) => setKeyboard(e.currentTarget.checked)}
        />
        {t($language, 'keyboardSource')}
      </label>

      <select value={gamepadValue} disabled={busy} on:change={(e) => setGamepad(e.currentTarget.value)}>
        <option value="none">{t($language, 'noController')}</option>
        {#if allowAuto}
          <option value="auto">{t($language, 'allFreeControllers')}</option>
        {/if}
        {#each pads as pad}
          <option value={String(pad.index)}>{padDisplayName(pad.id) || `#${pad.index + 1}`}</option>
        {/each}
      </select>

      <button
        type="button"
        disabled={busy || detecting || capturing !== null}
        on:click={startDetecting}
      >
        {t($language, 'detectController')}
      </button>
    </div>
  </header>

  <div class="tables" role="group">
    <button
      type="button"
      class:on={editing === 'keys'}
      disabled={capturing !== null}
      on:click={() => (editing = 'keys')}
    >
      {t($language, 'editingKeyboard')}
    </button>
    {#if hasPad}
      <button
        type="button"
        class:on={editing === 'pad'}
        disabled={capturing !== null}
        on:click={() => (editing = 'pad')}
      >
        {t($language, 'editingController')}
      </button>
    {/if}
  </div>

  <SnesPad
    {bindings}
    {capturing}
    {pressed}
    conflicts={activeConflicts}
    labels={buttonLabels}
    {descriptions}
    interactive={!busy && !detecting}
    on:select={(e) => startCapture(e.detail.button)}
  />

  <div class="actions">
    <button type="button" disabled={busy || capturing !== null || detecting} on:click={startSequence}>
      🎮 {t($language, 'configureAllButtons')}
    </button>
    {#if editing === 'pad'}
      <button type="button" disabled={busy || capturing !== null} on:click={resetPadToStandard}>
        {t($language, 'standardMapping')}
      </button>
    {/if}
  </div>

  {#if capturing}
    <p class="hint">
      {#if sequence >= 0}
        {t($language, 'bindingStep', {
          step: sequence + 1,
          total: BIND_ORDER.length,
          button: buttonLabels[capturing]
        })}
        <br />
        {t($language, 'pressEscToCancel')} · {t($language, 'pressTabToSkip')}
      {:else}
        {t($language, 'pressKeyToBind', { button: buttonLabels[capturing] })}
        <br />
        {t($language, 'pressEscToCancel')}
      {/if}
    </p>
  {:else if notice}
    <p class="hint">{notice}</p>
  {:else if player === 2 && !isPlayerActive(assignment)}
    <p class="hint quiet">{t($language, 'playerInactive')}</p>
  {/if}

  {#each [...conflicts[editing]] as [button, others]}
    <p class="conflict">
      ⚠️ {buttonLabels[button]} — {others
        .map((o) => t($language, 'alsoUsedByPlayer', { player: o.player, button: buttonLabels[o.button] }))
        .join(' · ')}
    </p>
  {/each}
</section>

<style>
  .player {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }

  header {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  h4 {
    margin: 0;
    font-size: 1rem;
    color: #eee;
  }

  .sources {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: #ccc;
  }

  .sources label {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .sources select,
  .sources button,
  .tables button,
  .actions button {
    background: #333;
    color: #eee;
    border: 1px solid #555;
    border-radius: 6px;
    padding: 0.35rem 0.7rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .sources select {
    max-width: 12rem;
  }

  .tables {
    display: flex;
    gap: 0.25rem;
  }

  .tables button.on {
    background: #1976d2;
    border-color: #1976d2;
    font-weight: 600;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .hint {
    margin: 0;
    background: #1976d2;
    color: white;
    padding: 0.6rem 0.75rem;
    border-radius: 6px;
    text-align: center;
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .hint.quiet {
    background: rgba(255, 255, 255, 0.08);
    color: #bbb;
  }

  .conflict {
    margin: 0;
    font-size: 0.8rem;
    color: #ff8a80;
    padding: 0.4rem 0.5rem;
    background: rgba(211, 47, 47, 0.15);
    border-left: 3px solid #d32f2f;
    border-radius: 4px;
  }

  button:disabled,
  select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
