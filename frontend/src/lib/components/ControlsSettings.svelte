<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { KeyConfig } from '$lib/types';
  import ConfirmModal from './ConfirmModal.svelte';
  import { CaptureGate } from '$lib/controls/capture-gate';
  import { createLogger } from '$lib/utils/logger';

  export let roomId: string = ''; // Optional - if empty, only saves to user profile
  export let currentConfig: KeyConfig;

  const dispatch = createEventDispatcher();
  const logger = createLogger('ControlsSettings');

  let isListening = false;
  let currentButton: keyof KeyConfig | null = null;
  let isLoading = false;
  let isSaving = false;
  let errorMessage = '';
  let gamepadPollInterval: number | null = null;
  let showResetConfirm = false;

  /**
   * The order the buttons are bound in, and the order they are listed in.
   *
   * Directions first, then faces, then shoulders, then the two in the middle:
   * a player working through the whole pad follows the same path as their
   * thumb, and never has to hunt for what is being asked of them.
   */
  const BIND_ORDER: (keyof KeyConfig)[] = [
    'up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'
  ];

  /** Position in BIND_ORDER while binding the whole pad; -1 when idle. */
  let sequenceIndex = -1;
  /** What to put back if the run is abandoned halfway through. */
  let configBeforeSequence: KeyConfig | null = null;
  /** Keeps one long press from filling every remaining slot. See capture-gate. */
  const gate = new CaptureGate();

  // Create a working copy of the config
  let workingConfig: KeyConfig = { ...currentConfig };

  // Button display names (reactive to language changes)
  $: buttonLabels = {
    up: t($language, 'dPadUp'),
    down: t($language, 'dPadDown'),
    left: t($language, 'dPadLeft'),
    right: t($language, 'dPadRight'),
    a: t($language, 'aButton'),
    b: t($language, 'bButton'),
    x: t($language, 'xButton'),
    y: t($language, 'yButton'),
    l: t($language, 'lShoulder'),
    r: t($language, 'rShoulder'),
    start: t($language, 'startButton'),
    select: t($language, 'selectButton')
  } as Record<keyof KeyConfig, string>;

  // Format key code for display
  function formatKeyDisplay(keyCode: string): string {
    // Gamepad button
    if (keyCode.startsWith('Gamepad')) {
      const match = keyCode.match(/Gamepad(\d+)Button(\d+)/);
      if (match) {
        return `🎮 ${t($language, 'controller')} ${parseInt(match[1]) + 1} ${t($language, 'button')} ${match[2]}`;
      }
      const axisMatch = keyCode.match(/Gamepad(\d+)Axis(\d+)(Plus|Minus)/);
      if (axisMatch) {
        return `🎮 ${t($language, 'controller')} ${parseInt(axisMatch[1]) + 1} ${t($language, 'axis')} ${axisMatch[2]} ${axisMatch[3]}`;
      }
      return keyCode;
    }

    // Keyboard keys
    if (keyCode.startsWith('Key')) {
      return keyCode.replace('Key', '');
    }
    if (keyCode.startsWith('Arrow')) {
      return `${keyCode.replace('Arrow', '')} ${t($language, 'arrow')}`;
    }
    if (keyCode.startsWith('Digit')) {
      return keyCode.replace('Digit', '');
    }
    if (keyCode === 'ShiftLeft') return t($language, 'leftShift');
    if (keyCode === 'ShiftRight') return t($language, 'rightShift');
    if (keyCode === 'ControlLeft') return t($language, 'leftCtrl');
    if (keyCode === 'ControlRight') return t($language, 'rightCtrl');
    if (keyCode === 'AltLeft') return t($language, 'leftAlt');
    if (keyCode === 'AltRight') return t($language, 'rightAlt');
    return keyCode;
  }

  // Start listening for key press
  function startRebind(button: keyof KeyConfig) {
    currentButton = button;
    isListening = true;
    errorMessage = '';
    gate.reset();

    // Start polling gamepads
    startGamepadPolling();
  }

  // Cancel rebinding
  function cancelRebind() {
    currentButton = null;
    isListening = false;
    sequenceIndex = -1;
    configBeforeSequence = null;
    stopGamepadPolling();
  }

  /** Binds every button in turn, one press each. */
  function startSequence() {
    configBeforeSequence = { ...workingConfig };
    sequenceIndex = 0;
    startRebind(BIND_ORDER[0]);
  }

  function advanceSequence() {
    sequenceIndex++;
    if (sequenceIndex >= BIND_ORDER.length) {
      cancelRebind();
      return;
    }
    currentButton = BIND_ORDER[sequenceIndex];
  }

  /**
   * Abandons the run and puts back what was there before it started.
   *
   * Keeping the bindings made so far would leave the pad half rewritten in a
   * state the player never chose and cannot see the shape of - worse than
   * either finishing the run or never having started it.
   */
  function cancelSequence() {
    if (configBeforeSequence) workingConfig = { ...configBeforeSequence };
    cancelRebind();
  }

  /** Writes one binding, and moves on if there is anywhere to move on to. */
  function applyCapture(inputCode: string) {
    if (!currentButton) return;

    workingConfig[currentButton] = inputCode;
    if (sequenceIndex >= 0) advanceSequence();
    else cancelRebind();
  }

  // Poll gamepad state
  function startGamepadPolling() {
    stopGamepadPolling(); // Clear any existing interval

    gamepadPollInterval = window.setInterval(() => {
      // Use original getGamepads if available (when called from emulator with virtual gamepads)
      // Otherwise use normal navigator.getGamepads (when called from homepage)
      const getGamepads = (window as any).__originalGetGamepads || navigator.getGamepads.bind(navigator);
      const gamepads = getGamepads();

      // Everything held down this tick, not just the first thing found: the
      // gate needs to see a button still held to know not to take it twice,
      // and a second button pressed before the first is released is a normal
      // way to work through a pad quickly.
      const active: string[] = [];

      // Remap physical gamepad indices (skip virtual gamepads)
      let physicalGamepadIndex = 0;

      for (let i = 0; i < gamepads.length; i++) {
        const gamepad = gamepads[i];
        if (!gamepad) continue;

        // Skip virtual gamepads when detecting input for config
        if (gamepad.id.includes('Virtual Gamepad')) {
          continue;
        }

        // Use remapped index for physical gamepads (starts from 0)
        const configIndex = physicalGamepadIndex;
        physicalGamepadIndex++;

        // Check buttons
        for (let j = 0; j < gamepad.buttons.length; j++) {
          if (gamepad.buttons[j].pressed) {
            active.push(`Gamepad${configIndex}Button${j}`);
          }
        }

        // Check axes (for d-pad on some controllers)
        for (let j = 0; j < gamepad.axes.length; j++) {
          const axisValue = gamepad.axes[j];
          if (Math.abs(axisValue) > 0.5) {
            const direction = axisValue > 0 ? 'Plus' : 'Minus';
            active.push(`Gamepad${configIndex}Axis${j}${direction}`);
          }
        }
      }

      const captured = gate.tick(active);
      if (captured) handleGamepadInput(captured);
    }, 50); // Poll every 50ms
  }

  function stopGamepadPolling() {
    if (gamepadPollInterval !== null) {
      clearInterval(gamepadPollInterval);
      gamepadPollInterval = null;
    }
  }

  function handleGamepadInput(inputCode: string) {
    if (!isListening || !currentButton) return;
    applyCapture(inputCode);
  }

  // The panel can be closed mid-bind - the pause menu is one click away from
  // it - and the poll would otherwise keep running for the life of the page.
  onDestroy(stopGamepadPolling);

  // Handle key press
  function handleKeyPress(event: KeyboardEvent) {
    if (!isListening || !currentButton) return;

    event.preventDefault();
    event.stopPropagation();

    // Ignore certain keys
    if (event.code === 'Escape') {
      if (sequenceIndex >= 0) cancelSequence();
      else cancelRebind();
      return;
    }

    // Leaves this button as it was and moves on. Without it, a player who
    // wants nothing on L and R has to either invent a binding or throw the
    // whole run away. Costs the ability to bind Tab itself, but only here.
    if (sequenceIndex >= 0 && event.code === 'Tab') {
      advanceSequence();
      return;
    }

    // Assign the new key (allow duplicates, will be highlighted)
    const code = gate.keydown(event);
    if (!code) return;
    applyCapture(code);
  }

  // Save configuration
  async function saveConfig() {
    isSaving = true;
    errorMessage = '';

    try {
      // Save to backend
      const response = await fetch('/api/user/controls', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(workingConfig)
      });

      if (!response.ok) {
        throw new Error('Failed to save controls');
      }

      // Update room config via WebSocket (only if in a room)
      if (roomId && $socket) {
        $socket.emit('room:updateKeyConfig', {
          roomId,
          keyConfig: workingConfig
        });
      }

      // Update parent component
      currentConfig = { ...workingConfig };

      // Emit saved event with new config to close modal and update parent
      dispatch('saved', { config: workingConfig });

    } catch (error) {
      logger.error('Error saving controls:', error);
      errorMessage = t($language, 'failedToSaveControls');
    } finally {
      isSaving = false;
    }
  }

  // Reset to defaults
  async function resetToDefaults() {
    showResetConfirm = true;
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

      if (!response.ok) {
        throw new Error('Failed to reset controls');
      }

      const data = await response.json();
      workingConfig = { ...data.config };

      // Update room config via WebSocket (only if in a room)
      if (roomId && $socket) {
        $socket.emit('room:updateKeyConfig', {
          roomId,
          keyConfig: workingConfig
        });
      }

      currentConfig = { ...workingConfig };

      // Emit saved event with new config
      dispatch('saved', { config: workingConfig });

    } catch (error) {
      logger.error('Error resetting controls:', error);
      errorMessage = t($language, 'failedToResetControls');
    } finally {
      isLoading = false;
    }
  }

  // Check if config has changed
  $: hasChanges = JSON.stringify(workingConfig) !== JSON.stringify(currentConfig);

  // Detect key conflicts
  $: conflicts = (() => {
    const keyToButtons: Record<string, string[]> = {};

    // Group buttons by their assigned keys
    Object.entries(workingConfig).forEach(([button, keyCode]) => {
      if (!keyToButtons[keyCode]) {
        keyToButtons[keyCode] = [];
      }
      keyToButtons[keyCode].push(button);
    });

    // Find keys assigned to multiple buttons
    const conflictSet = new Set<string>();
    Object.entries(keyToButtons).forEach(([_keyCode, buttons]) => {
      if (buttons.length > 1) {
        buttons.forEach(button => conflictSet.add(button));
      }
    });

    return conflictSet;
  })();

  // Check if a button has a conflict
  function hasConflict(button: string): boolean {
    return conflicts.has(button);
  }

  // Get conflicting buttons for a given button
  function getConflictingButtons(button: string): string[] {
    const keyCode = workingConfig[button as keyof KeyConfig];
    return Object.entries(workingConfig)
      .filter(([btn, code]) => btn !== button && code === keyCode)
      .map(([btn]) => buttonLabels[btn as keyof KeyConfig]);
  }

  // Check if save should be disabled
  $: canSave = hasChanges && conflicts.size === 0;

  // Helper to handle button click with proper typing
  function handleButtonClick(button: string) {
    startRebind(button as keyof KeyConfig);
  }

  // Helper to get key display with proper typing
  function getKeyDisplay(button: string): string {
    return formatKeyDisplay(workingConfig[button as keyof KeyConfig]);
  }
</script>

<svelte:window on:keydown={handleKeyPress} />

<div class="controls-settings">
  <button
    class="btn-sequence"
    on:click={startSequence}
    disabled={isListening || isLoading || isSaving}
  >
    🎮 {t($language, 'configureAllButtons')}
  </button>

  <div class="controls-grid">
    {#each BIND_ORDER as button, i}
      <div class="control-row">
        <div class="button-label">{buttonLabels[button]}</div>
        <div class="key-button-wrapper">
          <button
            class="key-button"
            class:listening={isListening && currentButton === button}
            class:bound={sequenceIndex >= 0 && i < sequenceIndex}
            class:pending={sequenceIndex >= 0 && i > sequenceIndex}
            class:conflict={hasConflict(button)}
            disabled={isListening && currentButton !== button}
            on:click={() => handleButtonClick(button)}
          >
            {#if isListening && currentButton === button}
              {t($language, 'pressAnyKey')}
            {:else}
              {getKeyDisplay(button)}
            {/if}
          </button>
          {#if hasConflict(button)}
            <div class="conflict-hint">
              ⚠️ {t($language, 'alsoUsedBy')} {getConflictingButtons(button).join(', ')}
            </div>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  {#if isListening && currentButton}
    <div class="listening-hint">
      {#if sequenceIndex >= 0}
        {t($language, 'bindingStep', {
          step: sequenceIndex + 1,
          total: BIND_ORDER.length,
          button: buttonLabels[currentButton]
        })}
        <br />
        {t($language, 'pressEscToCancel')} · {t($language, 'pressTabToSkip')}
        <div class="sequence-actions">
          <button class="btn-step" on:click={advanceSequence}>
            {t($language, 'skipBinding')} ⏭
          </button>
          <button class="btn-step" on:click={cancelSequence}>
            {t($language, 'cancel')}
          </button>
        </div>
      {:else}
        {t($language, 'pressKeyToBind', { button: buttonLabels[currentButton] })}
        <br />
        {t($language, 'pressEscToCancel')}
      {/if}
    </div>
  {/if}

  {#if conflicts.size > 0}
    <div class="conflict-warning">
      ⚠️ {t($language, 'conflictingAssignments', { count: conflicts.size })}
    </div>
  {/if}

  {#if errorMessage}
    <div class="error-message">{errorMessage}</div>
  {/if}

  <div class="actions">
    <button
      class="btn-reset"
      on:click={resetToDefaults}
      disabled={isLoading || isSaving || isListening}
    >
      {isLoading ? t($language, 'resetting') : t($language, 'resetToDefaults')}
    </button>

    <button
      class="btn-save"
      on:click={saveConfig}
      disabled={!canSave || isSaving || isListening}
    >
      {isSaving ? t($language, 'saving') : t($language, 'saveChanges')}
    </button>
  </div>
</div>

<style>
  .controls-settings {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .controls-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem 2rem;
  }

  .control-row {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 0.75rem;
    align-items: flex-start;
  }

  .button-label {
    font-weight: 500;
    color: #ddd;
    padding-top: 0.75rem;
  }

  .key-button-wrapper {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .key-button {
    background: #333;
    color: white;
    border: 2px solid #555;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.95rem;
    transition: all 0.2s;
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .key-button:hover:not(:disabled) {
    background: #444;
    border-color: #666;
  }

  .key-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-sequence {
    background: #2a2a3a;
    color: #eee;
    border: 2px solid #555;
    border-radius: 6px;
    padding: 0.75rem 1rem;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-sequence:hover:not(:disabled) {
    background: #37374d;
    border-color: #666;
  }

  .btn-sequence:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Progress through a run, read off the grid rather than off the counter.
     Every button but the current one is disabled and therefore dimmed, so
     the half that is already bound has to have that dimming taken back off
     - otherwise done and not-yet-done look exactly alike. */
  .key-button.bound:disabled {
    opacity: 1;
  }

  .key-button.pending {
    opacity: 0.35;
  }

  .sequence-actions {
    display: flex;
    justify-content: center;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .btn-step {
    background: rgba(255, 255, 255, 0.15);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.4);
    border-radius: 4px;
    padding: 0.4rem 0.9rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .btn-step:hover {
    background: rgba(255, 255, 255, 0.25);
  }

  .key-button.listening {
    background: #1976d2;
    border-color: #1976d2;
    animation: pulse 1s ease-in-out infinite;
  }

  .key-button.conflict {
    background: rgba(211, 47, 47, 0.2);
    border-color: #d32f2f;
    color: #ff8a80;
  }

  .key-button.conflict:hover:not(:disabled) {
    background: rgba(211, 47, 47, 0.3);
    border-color: #f44336;
  }

  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.7;
    }
  }

  .conflict-hint {
    font-size: 0.8rem;
    color: #ff8a80;
    padding: 0.5rem;
    background: rgba(211, 47, 47, 0.15);
    border-radius: 4px;
    border-left: 3px solid #d32f2f;
  }

  .listening-hint {
    background: #1976d2;
    color: white;
    padding: 1rem;
    border-radius: 6px;
    text-align: center;
    font-size: 0.95rem;
    line-height: 1.5;
  }

  .conflict-warning {
    background: rgba(255, 152, 0, 0.2);
    border: 2px solid #ff9800;
    color: #ffb74d;
    padding: 1rem;
    border-radius: 6px;
    text-align: center;
    font-size: 0.95rem;
    line-height: 1.5;
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
    padding-top: 0.5rem;
  }

  .actions button {
    flex: 1;
    padding: 0.875rem;
    border: none;
    border-radius: 6px;
    font-size: 0.95rem;
    cursor: pointer;
    transition: all 0.2s;
    font-weight: 500;
  }

  .btn-reset {
    background: #666;
    color: white;
  }

  .btn-reset:hover:not(:disabled) {
    background: #777;
  }

  .btn-save {
    background: #4caf50;
    color: white;
  }

  .btn-save:hover:not(:disabled) {
    background: #45a049;
  }

  .actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 768px) {
    .controls-grid {
      grid-template-columns: 1fr;
    }
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
    on:cancel={() => showResetConfirm = false}
  />
{/if}
