<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import ControlsSettings from './ControlsSettings.svelte';
  import LoadSavesMenu from './LoadSavesMenu.svelte';
  import SaveGameMenu from './SaveGameMenu.svelte';
  import ConfirmModal from './ConfirmModal.svelte';
  import { socket } from '$lib/api/socket';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { KeyConfig, LatencyMode } from '$lib/types';
  import type { DisplayOptions } from '$lib/znet';
  import type { ControlsConfig } from '$lib/controls/binding';
  import { SHADERS, VALID_SHADER_IDS } from '$lib/shaders';

  export let roomId: string;
  export let gameId: string;
  export let keyConfig: KeyConfig;
  /**
   * The two-player config, for the controls sub-menu.
   *
   * Distinct from `keyConfig`, which is the P1 half the room carries: this
   * panel edits both players, and handing it the half would hide the second
   * from it.
   */
  export let controls: ControlsConfig;
  /** Passed straight to the controls panel; see its own prop for why. */
  export let localPlayer2Playable = true;
  export let emulator: any = null; // Reference to ClientEmulator component (host only)
  export let restoreFullscreen: boolean = false; // Whether to restore fullscreen on resume

  /**
   * Display settings, or null for a room that has none to offer.
   *
   * These used to be a row of buttons along the bottom of the game screen, in
   * both rooms, in hardcoded English. They live here instead because nobody
   * changes them mid-game, and because a menu item inherits this component's
   * keyboard navigation for free - a separate toggle row along the bottom of
   * the picture would be pointer-only.
   */
  export let display: DisplayOptions | null = null;
  /** null where fast-forward is not offered: in lockstep it would stall the peer. */
  export let turbo: boolean | null = null;
  /** null where there are no network statistics to show: solo. */
  export let showStats: boolean | null = null;
  /**
   * The room's latency trade-off, or null where there is none to show: solo, and
   * the modes that are not lockstep.
   */
  export let latencyMode: LatencyMode | null = null;
  /**
   * Whether this player may change it. Only the room's creator can, so for
   * everyone else the entry explains what they are playing under rather than
   * being something to press.
   */
  export let canSetLatency = false;

  /**
   * Whether this room offers a restart, and this player may press it.
   *
   * False by default, which is what the dual and streaming rooms want: they
   * have no savestate path at all, so there is nothing here that could put a
   * game back on its feet afterwards. In lockstep only the host is offered it,
   * because the restart reaches the guest as a resync - two peers each
   * restarting on their own would be two machines that merely started from the
   * same reset, which is the distinction `onSaveLoaded` is built around too.
   */
  export let canReset = false;

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
  let showResetConfirm = false;
  /**
   * -1 for "nothing chosen yet", which is how the menu now opens.
   *
   * It used to open on 0 and put the focus ring on Resume, so every pause
   * began with one entry lit up for no reason the player had given. The
   * highlight answers the arrow keys now; it is not a greeting.
   */
  let selectedIndex = -1;
  let menuButtons: HTMLButtonElement[] = [];

  // A reverse map from the player's bindings to the button they stand for, so
  // the keys they play with also work here: B backs out, A and Start choose.
  // Only the keyboard half can ever match now that the pad no longer drives
  // this menu - a `Gamepad0Button1` binding simply never equals a KeyboardEvent
  // code, so those entries sit inert rather than needing to be filtered out.
  let keyCodeToButton: Record<string, keyof KeyConfig> = {};
  $: {
    keyCodeToButton = {};
    for (const [button, keyCode] of Object.entries(keyConfig)) {
      keyCodeToButton[keyCode] = button as keyof KeyConfig;
    }
  }

  /**
   * Display entries, folded into the same array as everything else so they
   * inherit the arrow-key navigation below. Each label carries its current
   * value, the way the old toolbar buttons did.
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
    ...(showStats === null
      ? []
      : [
          {
            label: `${t($language, 'netplayStats')}: ${t($language, showStats ? 'shown' : 'hidden')}`,
            action: () => dispatch('stats')
          }
        ]),
    /*
     * The latency trade-off. Shown to everyone, pressable only by the creator: a
     * guest wondering why the game feels heavy deserves to see that it is set to
     * protect their picture, even though they cannot change it.
     */
    ...(latencyMode === null
      ? []
      : [
          {
            label: `${t($language, 'latency')}: ${t(
              $language,
              latencyMode === 'low' ? 'latencyLow' : 'latencyAuto'
            )}`,
            action: canSetLatency ? () => dispatch('latency') : () => {}
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
    ...(canReset
      ? [
          {
            label: t($language, 'resetGame'),
            action: () => (showResetConfirm = true),
            danger: true
          }
        ]
      : []),
    { label: t($language, 'quit'), action: () => dispatch('quit'), danger: true }
  ];

  // The list can grow or shrink between rooms; never leave the cursor past its
  // end. -1 is not past it: it is the cursor sitting outside the list on purpose.
  $: if (selectedIndex >= menuItems.length) selectedIndex = menuItems.length - 1;

  /**
   * A save is no longer the end of anything, so it closes nothing.
   *
   * This used to fire once, when the player pressed a "save" button, and
   * returning them to the menu was the natural end of that gesture. Bindings
   * now persist as they are captured, so the same handler ran on every single
   * rebind and shut the panel under the player's hands - which read as the
   * binding having failed. The submenu closes when they ask it to: the Close
   * button, or Escape.
   */
  function handleSaved(event: CustomEvent<{ config: ControlsConfig }>) {
    controls = event.detail.config;
    dispatch('controlsSaved', { config: event.detail.config });
  }

  function handleKeyDown(e: KeyboardEvent) {
    // The confirmation owns the keyboard while it is up: it binds Escape and
    // Enter on the window itself, so acting on them here as well would answer
    // the modal and step out of the menu behind it in the same press.
    if (showResetConfirm) return;
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

    // Up and down, wrapping. Written against the ends of the list rather than
    // as modular arithmetic because the cursor starts outside it: from -1, up
    // has to mean the last entry, and `(i - 1 + n) % n` gets that wrong.
    if (button === 'up' || e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = selectedIndex <= 0 ? menuItems.length - 1 : selectedIndex - 1;
      menuButtons[selectedIndex]?.focus();
    } else if (button === 'down' || e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = selectedIndex >= menuItems.length - 1 ? 0 : selectedIndex + 1;
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


  /**
   * Restarts the machine and puts the player back in front of it.
   *
   * Resuming is the point rather than an afterthought: this is a power cycle,
   * and a power cycle ends with the game on screen. It also has to happen in
   * this click - restoring fullscreen needs a user gesture, and the modal's
   * confirm button is the last one available.
   */
  function confirmReset() {
    showResetConfirm = false;
    dispatch('reset');
    handleResumeWithFullscreen();
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
    // Back to nothing chosen, and the focus is left where the player put it
    // rather than yanked onto the first entry.
    selectedIndex = -1;
  }

  function handleNotification(event: CustomEvent<{ message: string; type: 'success' | 'error' }>) {
    // Forward notification to parent (room component)
    dispatch('notification', event.detail);
  }

  function handleSaveClose() {
    handleBackFromSubmenu();
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeyDown);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeyDown);
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
        <ControlsSettings
          {roomId}
          currentConfig={controls}
          {localPlayer2Playable}
          on:saved={handleSaved}
        />
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

{#if showResetConfirm}
  <ConfirmModal
    title={t($language, 'resetGame')}
    message={t($language, 'confirmResetGame')}
    confirmText={t($language, 'resetGame')}
    cancelText={t($language, 'cancel')}
    danger={true}
    on:confirm={confirmReset}
    on:cancel={() => (showResetConfirm = false)}
  />
{/if}

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
