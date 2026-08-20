<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import ControlsSettings from './ControlsSettings.svelte';
  import LoadSavesMenu from './LoadSavesMenu.svelte';
  import SaveGameMenu from './SaveGameMenu.svelte';
  import { socket } from '$lib/api/socket';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { KeyConfig } from '$lib/types';
  import type { DisplayOptions } from '$lib/znet';
  import { SHADERS, VALID_SHADER_IDS } from './ShaderSelector.svelte';

  export let roomId: string;
  export let gameId: string;
  export let keyConfig: KeyConfig;
  export let emulator: any = null; // Reference to ClientEmulator component (host only)
  export let restoreFullscreen: boolean = false; // Whether to restore fullscreen on resume

  /**
   * Display settings, or null for a room that has none to offer.
   *
   * These used to be a row of buttons along the bottom of the game screen, in
   * both rooms, in hardcoded English. They live here instead because nobody
   * changes them mid-game, and because a menu item inherits this component's
   * keyboard and gamepad navigation for free - a separate toggle row would be
   * mouse-only, in a menu built to be driven by a pad.
   */
  export let display: DisplayOptions | null = null;
  /** null where fast-forward is not offered: in lockstep it would stall the peer. */
  export let turbo: boolean | null = null;
  /** null where there are no network statistics to show: solo. */
  export let showStats: boolean | null = null;
  /**
   * The already-formatted name of the gamepad driving this player, or null
   * where there is no picker. Formatted by the room rather than here: which
   * pads are connected is its business, and this only has to render a string.
   */
  export let gamepadLabel: string | null = null;

  const dispatch = createEventDispatcher();

  interface MenuItem {
    label: string;
    action: () => void;
    danger?: boolean;
  }

  /** The translated name of a shader id, using the same list the picker shows. */
  function shaderName(id: string): string {
    const entry = SHADERS.find((s) => s.id === id) ?? SHADERS[0];
    return t($language, entry.name);
  }

  function cycleShader(): void {
    if (!display) return;
    const next =
      VALID_SHADER_IDS[(VALID_SHADER_IDS.indexOf(display.shader) + 1) % VALID_SHADER_IDS.length];
    dispatch('display', { ...display, shader: next });
  }

  let showKeyConfig = false;
  let showLoadSaves = false;
  let showSaveGame = false;
  let showVideo = false;
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

  /**
   * Display entries, folded into the same array as everything else so they
   * inherit the arrow-key and gamepad navigation below. Each label carries its
   * current value, the way the old toolbar buttons did.
   */
  let displayItems: MenuItem[] = [];
  $: displayItems = display
    ? [
        {
          // The values are ratios, so they need no translating.
          label: `${t($language, 'aspect')}: ${display.aspect === 'crt' ? '4:3' : '1:1'}`,
          action: () =>
            dispatch('display', {
              ...display,
              aspect: display!.aspect === 'square' ? 'crt' : 'square'
            })
        },
        { label: `${t($language, 'shader')}: ${shaderName(display.shader)}`, action: cycleShader }
      ]
    : [];

  let extraItems: MenuItem[] = [];
  $: extraItems = [
    ...(turbo === null
      ? []
      : [
          {
            label: `${t($language, 'fastForward')}: ${t($language, turbo ? 'on' : 'off')}`,
            action: () => dispatch('turbo')
          }
        ]),
    ...(gamepadLabel === null
      ? []
      : [
          {
            label: `${t($language, 'gamepad')}: ${gamepadLabel}`,
            action: () => dispatch('gamepad')
          }
        ]),
    ...(showStats === null
      ? []
      : [
          {
            label: `${t($language, 'netplayStats')}: ${t($language, showStats ? 'shown' : 'hidden')}`,
            action: () => dispatch('stats')
          }
        ]),
  ];

  let menuItems: MenuItem[] = [];
  /** The root list: one "Video" door instead of four graphics rows at the top level. */
  $: menuItems = [
    { label: t($language, 'resume'), action: () => handleResumeWithFullscreen() },
    { label: t($language, 'controls'), action: () => showKeyConfig = true },
    { label: t($language, 'loadGame'), action: () => showLoadSaves = true },
    { label: t($language, 'saveGame'), action: () => showSaveGame = true },
    ...(display ? [{ label: t($language, 'video'), action: () => (showVideo = true) }] : []),
    ...extraItems,
    { label: t($language, 'quit'), action: () => dispatch('quit'), danger: true }
  ];

  // The list can grow or shrink between rooms; never leave the cursor past its end.
  $: if (selectedIndex >= menuItems.length) selectedIndex = menuItems.length - 1;

  function handleSaved(event: CustomEvent<{ config: KeyConfig }>) {
    // Forward the saved config to parent
    dispatch('saved', event.detail);
    showKeyConfig = false;
    selectedIndex = 0; // Reset selection when returning to main menu
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // The browser takes this press to leave fullscreen, so acting on it too
      // would do two things at once. Let it have this one; the next press
      // steps back through the menu.
      if (document.fullscreenElement) return;
      e.preventDefault();
      if (showKeyConfig || showLoadSaves || showSaveGame || showVideo) {
        handleBackFromSubmenu();
      } else {
        handleResumeWithFullscreen();
      }
      return;
    }
    // Skip navigation when in submenus
    if (showKeyConfig || showLoadSaves || showSaveGame || showVideo) return;

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
    // Handle B button to resume
    else if (button === 'b') {
      e.preventDefault();
      e.stopPropagation();
      handleResumeWithFullscreen();
    }
  }


  function handleResumeWithFullscreen() {
    // Request fullscreen (must be in user gesture handler)
    if (restoreFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
    dispatch('resume');
  }

  function handleBackFromSubmenu() {
    showKeyConfig = false;
    showLoadSaves = false;
    showSaveGame = false;
    showVideo = false;
    selectedIndex = 0;
    // Refocus the menu after a short delay to ensure DOM is updated
    setTimeout(() => menuButtons[selectedIndex]?.focus(), 50);
  }

  function handleNotification(event: CustomEvent<{ message: string; type: 'success' | 'error' }>) {
    // Forward notification to parent (room component)
    dispatch('notification', event.detail);
  }

  function handleSaveClose() {
    handleBackFromSubmenu();
  }

  // Poll gamepad state for menu navigation
  function startGamepadPolling() {
    if (gamepadPollInterval !== null) return;

    gamepadPollInterval = window.setInterval(() => {
      // Skip if in submenus
      if (showKeyConfig || showLoadSaves || showSaveGame || showVideo) return;

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
              handleResumeWithFullscreen();
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

<div class="pause-overlay" transition:fly={{ x: -320, duration: 220, easing: cubicOut }}>
  <div class="pause-menu">
    {#if !showKeyConfig && !showLoadSaves && !showSaveGame && !showVideo}
      <h2>{t($language, 'pauseMenu')}</h2>
      <p class="hint">{t($language, 'pauseMenuHint')}</p>

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

    {#if showVideo}
      <div class="submenu">
        <h3>{t($language, 'video')}</h3>
        <div class="menu-items">
          {#each displayItems as item}
            <button on:click={item.action}>{item.label}</button>
          {/each}
        </div>
        <button on:click={handleBackFromSubmenu} class="back-button">
          {t($language, 'close')}
        </button>
      </div>
    {/if}

    {#if showKeyConfig}
      <div class="submenu">
        <h3>{t($language, 'controls')}</h3>
        <ControlsSettings {roomId} currentConfig={keyConfig} on:saved={handleSaved} />
        <button on:click={handleBackFromSubmenu} class="back-button">
          {t($language, 'close')}
        </button>
      </div>
    {/if}

    {#if showLoadSaves}
      <div class="submenu">
        <LoadSavesMenu
          {roomId}
          {gameId}
          on:notification={handleNotification}
          on:close={handleSaveClose}
        />
        <button on:click={handleBackFromSubmenu} class="back-button">
          {t($language, 'close')}
        </button>
      </div>
    {/if}

    {#if showSaveGame}
      <div class="submenu">
        <SaveGameMenu
          {roomId}
          {gameId}
          {emulator}
          on:notification={handleNotification}
        />
        <button on:click={handleBackFromSubmenu} class="back-button">
          {t($language, 'close')}
        </button>
      </div>
    {/if}

  </div>
</div>

<style>
  /**
   * Docked to the left rather than covering the picture.
   *
   * Covering it made the live preview of the video settings pointless: you
   * changed a shader and saw the menu. The room reserves this width on its own
   * side (see each room's .paused rule), so the game shrinks instead of being
   * hidden.
   */
  .pause-overlay {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: var(--pause-panel-width, 20rem);
    background: rgba(18, 18, 18, 0.96);
    box-shadow: 0 0 24px rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: flex-start;
    overflow-y: auto;
    z-index: 1000;
  }

  /*
   * Too narrow to give a panel its own column: the game would be a stamp. Fall
   * back to covering, which is what this used to do everywhere.
   */
  @media (max-width: 700px) {
    .pause-overlay {
      width: 100%;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.94);
    }
  }

  .pause-menu {
    background: transparent;
    padding: 1.5rem 1.25rem;
    width: 100%;
  }

  @media (max-width: 700px) {
    .pause-menu {
      background: #2a2a2a;
      border-radius: 12px;
      padding: 2rem;
      max-width: 900px;
      width: 90%;
    }
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
