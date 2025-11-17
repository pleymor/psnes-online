<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { socket } from '$lib/api/socket';
  import type { KeyConfig } from '$lib/types';

  export let roomId: string = ''; // Optional - if empty, only saves to user profile
  export let currentConfig: KeyConfig;

  const dispatch = createEventDispatcher();

  let isListening = false;
  let currentButton: keyof KeyConfig | null = null;
  let isLoading = false;
  let isSaving = false;
  let errorMessage = '';

  // Create a working copy of the config
  let workingConfig: KeyConfig = { ...currentConfig };

  // Button display names
  const buttonLabels: Record<keyof KeyConfig, string> = {
    up: 'D-Pad Up',
    down: 'D-Pad Down',
    left: 'D-Pad Left',
    right: 'D-Pad Right',
    a: 'A Button',
    b: 'B Button',
    x: 'X Button',
    y: 'Y Button',
    l: 'L Shoulder',
    r: 'R Shoulder',
    start: 'Start',
    select: 'Select'
  };

  // Format key code for display
  function formatKeyDisplay(keyCode: string): string {
    if (keyCode.startsWith('Key')) {
      return keyCode.replace('Key', '');
    }
    if (keyCode.startsWith('Arrow')) {
      return keyCode.replace('Arrow', '') + ' Arrow';
    }
    if (keyCode.startsWith('Digit')) {
      return keyCode.replace('Digit', '');
    }
    if (keyCode === 'ShiftLeft') return 'Left Shift';
    if (keyCode === 'ShiftRight') return 'Right Shift';
    if (keyCode === 'ControlLeft') return 'Left Ctrl';
    if (keyCode === 'ControlRight') return 'Right Ctrl';
    if (keyCode === 'AltLeft') return 'Left Alt';
    if (keyCode === 'AltRight') return 'Right Alt';
    return keyCode;
  }

  // Start listening for key press
  function startRebind(button: keyof KeyConfig) {
    currentButton = button;
    isListening = true;
    errorMessage = '';
  }

  // Cancel rebinding
  function cancelRebind() {
    currentButton = null;
    isListening = false;
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
      errorMessage = 'Failed to save controls configuration';
    } finally {
      isSaving = false;
    }
  }

  // Reset to defaults
  async function resetToDefaults() {
    if (!confirm('Reset all controls to default settings?')) return;

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
      errorMessage = 'Failed to reset controls';
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
              Press any key...
            {:else}
              {getKeyDisplay(button)}
            {/if}
          </button>
          {#if hasConflict(button)}
            <div class="conflict-hint">
              ⚠️ Also used by: {getConflictingButtons(button).join(', ')}
            </div>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  {#if isListening && currentButton}
    <div class="listening-hint">
      Press a key to bind it to {buttonLabels[currentButton]}
      <br />
      Press ESC to cancel
    </div>
  {/if}

  {#if conflicts.size > 0}
    <div class="conflict-warning">
      ⚠️ {conflicts.size} button{conflicts.size > 1 ? 's have' : ' has'} conflicting key assignments.
      Please resolve conflicts before saving.
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
      {isLoading ? 'Resetting...' : 'Reset to Defaults'}
    </button>

    <button
      class="btn-save"
      on:click={saveConfig}
      disabled={!canSave || isSaving || isListening}
    >
      {isSaving ? 'Saving...' : 'Save Changes'}
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
    gap: 0.75rem;
  }

  .control-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
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
</style>
