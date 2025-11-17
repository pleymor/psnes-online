<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import ControlsSettings from './ControlsSettings.svelte';
  import type { KeyConfig } from '$lib/types';

  export let roomId: string;
  export let keyConfig: KeyConfig;

  const dispatch = createEventDispatcher();

  let showKeyConfig = false;
  let showSaveLoad = false;
  let selectedIndex = 0;
  let menuButtons: HTMLButtonElement[] = [];
  let gamepadPollInterval: number | null = null;
  let lastGamepadState: Record<string, boolean> = {};

  // Create a reverse mapping from key codes to button names
  let keyCodeToButton: Record<string, keyof KeyConfig> = {};
  $: {
    keyCodeToButton = {};
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      keyCodeToButton[keyCode] = button as keyof KeyConfig;
    }
  }

  const menuItems = [
    { label: 'Resume Game', action: () => dispatch('resume') },
    { label: 'Key Configuration', action: () => showKeyConfig = true },
    { label: 'Save / Load', action: () => showSaveLoad = true },
    { label: 'Stop Game', action: () => dispatch('quit'), danger: true }
  ];

  function handleSaved(event: CustomEvent<{ config: KeyConfig }>) {
    // Forward the saved config to parent
    dispatch('saved', event.detail);
    showKeyConfig = false;
    selectedIndex = 0; // Reset selection when returning to main menu
  }

  function handleKeyDown(e: KeyboardEvent) {
    // Skip navigation when in submenus
    if (showKeyConfig || showSaveLoad) return;

    const button = keyCodeToButton[e.code];

    // Handle D-pad up/down navigation
    if (button === 'up' || e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + menuItems.length) % menuItems.length;
      menuButtons[selectedIndex]?.focus();
    } else if (button === 'down' || e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % menuItems.length;
      menuButtons[selectedIndex]?.focus();
    }
    // Handle A button or Enter/Start for selection
    else if (button === 'a' || button === 'start' || e.key === 'Enter') {
      e.preventDefault();
      menuButtons[selectedIndex]?.click();
    }
    // Handle B button or Escape to resume
    else if (button === 'b' || e.key === 'Escape') {
      e.preventDefault();
      dispatch('resume');
    }
  }

  function handleBackFromSubmenu() {
    showKeyConfig = false;
    showSaveLoad = false;
    selectedIndex = 0;
    // Refocus the menu after a short delay to ensure DOM is updated
    setTimeout(() => menuButtons[selectedIndex]?.focus(), 50);
  }

  // Poll gamepad state for menu navigation
  function startGamepadPolling() {
    if (gamepadPollInterval !== null) return;

    gamepadPollInterval = window.setInterval(() => {
      // Skip if in submenus
      if (showKeyConfig || showSaveLoad) return;

      const gamepads = navigator.getGamepads();

      for (let i = 0; i < gamepads.length; i++) {
        const gamepad = gamepads[i];
        if (!gamepad) continue;

        // Check buttons
        for (let j = 0; j < gamepad.buttons.length; j++) {
          const inputCode = `Gamepad${i}Button${j}`;
          const isPressed = gamepad.buttons[j].pressed;
          const wasPressed = lastGamepadState[inputCode];

          // Only trigger on button press (not hold)
          if (isPressed && !wasPressed) {
            const button = keyCodeToButton[inputCode];

            if (button === 'up') {
              selectedIndex = (selectedIndex - 1 + menuItems.length) % menuItems.length;
              menuButtons[selectedIndex]?.focus();
            } else if (button === 'down') {
              selectedIndex = (selectedIndex + 1) % menuItems.length;
              menuButtons[selectedIndex]?.focus();
            } else if (button === 'a' || button === 'start') {
              menuButtons[selectedIndex]?.click();
            } else if (button === 'b') {
              dispatch('resume');
            }
          }

          lastGamepadState[inputCode] = isPressed;
        }

        // Check axes (for d-pad on some controllers)
        for (let j = 0; j < gamepad.axes.length; j++) {
          const axisValue = gamepad.axes[j];

          if (Math.abs(axisValue) > 0.5) {
            const direction = axisValue > 0 ? 'Plus' : 'Minus';
            const inputCode = `Gamepad${i}Axis${j}${direction}`;
            const wasPressed = lastGamepadState[inputCode];

            if (!wasPressed) {
              const button = keyCodeToButton[inputCode];

              if (button === 'up') {
                selectedIndex = (selectedIndex - 1 + menuItems.length) % menuItems.length;
                menuButtons[selectedIndex]?.focus();
              } else if (button === 'down') {
                selectedIndex = (selectedIndex + 1) % menuItems.length;
                menuButtons[selectedIndex]?.focus();
              }
            }

            lastGamepadState[inputCode] = true;
          } else {
            // Reset axis state when centered
            const inputCodePlus = `Gamepad${i}Axis${j}Plus`;
            const inputCodeMinus = `Gamepad${i}Axis${j}Minus`;
            lastGamepadState[inputCodePlus] = false;
            lastGamepadState[inputCodeMinus] = false;
          }
        }
      }
    }, 100); // Poll every 100ms
  }

  function stopGamepadPolling() {
    if (gamepadPollInterval !== null) {
      clearInterval(gamepadPollInterval);
      gamepadPollInterval = null;
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeyDown);
    startGamepadPolling();
    // Focus the first menu item on mount
    setTimeout(() => menuButtons[selectedIndex]?.focus(), 50);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeyDown);
    stopGamepadPolling();
  });
</script>

<div class="pause-overlay">
  <div class="pause-menu">
    {#if !showKeyConfig && !showSaveLoad}
      <h2>Paused</h2>
      <p class="hint">Use D-Pad + A to select, B to resume</p>

      <div class="menu-items">
        {#each menuItems as item, i}
          <button
            bind:this={menuButtons[i]}
            on:click={item.action}
            class:selected={selectedIndex === i}
            class:btn-danger={item.danger}
          >
            {item.label}
          </button>
        {/each}
      </div>
    {/if}

    {#if showKeyConfig}
      <div class="submenu">
        <h3>Key Configuration</h3>
        <ControlsSettings {roomId} currentConfig={keyConfig} on:saved={handleSaved} />
        <button on:click={handleBackFromSubmenu} class="back-button">Back</button>
      </div>
    {/if}

    {#if showSaveLoad}
      <div class="submenu">
        <h3>Save / Load</h3>
        <p>Save state management coming soon...</p>
        <button on:click={handleBackFromSubmenu} class="back-button">Back</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .pause-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.9);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  }

  .pause-menu {
    background: #2a2a2a;
    border-radius: 12px;
    padding: 2rem;
    max-width: 900px;
    width: 90%;
  }

  h2 {
    margin-top: 0;
    margin-bottom: 0.5rem;
    text-align: center;
  }

  .hint {
    text-align: center;
    color: #888;
    font-size: 0.85rem;
    margin-bottom: 1.5rem;
  }

  .menu-items {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .menu-items button {
    background: #444;
    color: white;
    border: 2px solid transparent;
    padding: 1rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    transition: all 0.2s;
  }

  .menu-items button:hover,
  .menu-items button.selected {
    background: #555;
    border: 2px solid #667eea;
    transform: translateX(8px);
  }

  .btn-danger {
    background: #d32f2f !important;
  }

  .btn-danger:hover {
    background: #b71c1c !important;
  }

  .submenu {
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid #444;
  }

  h3 {
    margin-top: 0;
  }

  .back-button {
    margin-top: 1rem;
    background: #444;
    color: white;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    width: 100%;
  }

  .back-button:hover {
    background: #555;
  }
</style>
