<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { socket } from '$lib/api/socket';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { KeyConfig } from '$lib/types';
  import ConfirmModal from './ConfirmModal.svelte';

  export let roomId: string = ''; // Optional - if empty, only saves to user profile
  export let currentConfig: KeyConfig;

  const dispatch = createEventDispatcher();

  let isListening = false;
  let currentButton: keyof KeyConfig | null = null;
  let isLoading = false;
  let isSaving = false;
  let errorMessage = '';
  let gamepadPollInterval: number | null = null;
  let showResetConfirm = false;

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

    // Start polling gamepads
    startGamepadPolling();
  }

  // Cancel rebinding
  function cancelRebind() {
    currentButton = null;
    isListening = false;
    stopGamepadPolling();
  }

  // Poll gamepad state
  function startGamepadPolling() {
    stopGamepadPolling(); // Clear any existing interval

    gamepadPollInterval = window.setInterval(() => {
      // Use original getGamepads if available (when called from emulator with virtual gamepads)
      // Otherwise use normal navigator.getGamepads (when called from homepage)
      const getGamepads = (window as any).__originalGetGamepads || navigator.getGamepads.bind(navigator);
      const gamepads = getGamepads();

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
            handleGamepadInput(`Gamepad${configIndex}Button${j}`);
            return;
          }
        }

        // Check axes (for d-pad on some controllers)
        for (let j = 0; j < gamepad.axes.length; j++) {
          const axisValue = gamepad.axes[j];
          if (Math.abs(axisValue) > 0.5) {
            const direction = axisValue > 0 ? 'Plus' : 'Minus';
            handleGamepadInput(`Gamepad${configIndex}Axis${j}${direction}`);
            return;
          }
        }
      }
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

    workingConfig[currentButton] = inputCode;
    cancelRebind();
  }

  // Handle key press
  function handleKeyPress(event: KeyboardEvent) {
    if (!isListening || !currentButton) return;

    event.preventDefault();
    event.stopPropagation();

    // Ignore certain keys
    if (event.code === 'Escape') {
      cancelRebind();
      return;
    }

    // Assign the new key (allow duplicates, will be highlighted)
    workingConfig[currentButton] = event.code;
    cancelRebind();
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
      console.error('Error saving controls:', error);
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
      console.error('Error resetting controls:', error);
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
  <div class="controls-grid">
    {#each Object.entries(buttonLabels) as [button, label]}
      <div class="control-row">
        <div class="button-label">{label}</div>
        <div class="key-button-wrapper">
          <button
            class="key-button"
            class:listening={isListening && currentButton === button}
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
      {t($language, 'pressKeyToBind', { button: buttonLabels[currentButton] })}
      <br />
      {t($language, 'pressEscToCancel')}
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
