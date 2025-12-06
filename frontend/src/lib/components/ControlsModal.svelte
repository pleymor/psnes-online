<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import ControlsSettings from './ControlsSettings.svelte';
  import type { KeyConfig } from '$lib/types';

  export let show: boolean = false;
  export let roomId: string = '';
  export let currentConfig: KeyConfig;

  const dispatch = createEventDispatcher();

  function close() {
    show = false;
    dispatch('close');
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      close();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && show) {
      close();
    }
  }

  function handleSaved(event: CustomEvent<{ config: KeyConfig }>) {
    // Forward the saved config to parent
    dispatch('saved', event.detail);
    close();
  }
</script>

<svelte:window on:keydown={handleKeyDown} />

{#if show}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-overlay" role="presentation" on:click={handleBackdropClick}>
    <div class="modal-content" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>🎮 {t($language, 'controllerSettings')}</h2>
        <button class="close-btn" on:click={close}>✕</button>
      </div>

      <div class="modal-body">
        <ControlsSettings {roomId} {currentConfig} on:saved={handleSaved} />
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2000;
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .modal-content {
    background: #2a2a2a;
    border-radius: 12px;
    max-width: 600px;
    width: 90%;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: slideUp 0.3s ease-out;
  }

  @keyframes slideUp {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.5rem;
    border-bottom: 1px solid #444;
  }

  h2 {
    margin: 0;
    font-size: 1.5rem;
    color: #fff;
  }

  .close-btn {
    background: transparent;
    border: none;
    color: #999;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0.5rem;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }

  .close-btn:hover {
    background: #444;
    color: #fff;
  }

  .modal-body {
    padding: 1.5rem;
    overflow-y: auto;
  }

  /* Scrollbar styling */
  .modal-body::-webkit-scrollbar {
    width: 8px;
  }

  .modal-body::-webkit-scrollbar-track {
    background: #1a1a1a;
  }

  .modal-body::-webkit-scrollbar-thumb {
    background: #555;
    border-radius: 4px;
  }

  .modal-body::-webkit-scrollbar-thumb:hover {
    background: #666;
  }
</style>
