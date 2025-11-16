<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let roomId: string; // Used for save/load functionality (coming soon)

  const dispatch = createEventDispatcher();

  let showKeyConfig = false;
  let showSaveLoad = false;
</script>

<div class="pause-overlay">
  <div class="pause-menu">
    <h2>Paused</h2>

    <div class="menu-items">
      <button on:click={() => dispatch('resume')}>
        Resume Game
      </button>

      <button on:click={() => showKeyConfig = true}>
        Key Configuration
      </button>

      <button on:click={() => showSaveLoad = true}>
        Save / Load
      </button>

      <button on:click={() => dispatch('quit')} class="btn-danger">
        Stop Game
      </button>
    </div>

    {#if showKeyConfig}
      <div class="submenu">
        <h3>Key Configuration</h3>
        <p>Key configuration UI coming soon...</p>
        <button on:click={() => showKeyConfig = false}>Back</button>
      </div>
    {/if}

    {#if showSaveLoad}
      <div class="submenu">
        <h3>Save / Load</h3>
        <p>Save state management coming soon...</p>
        <button on:click={() => showSaveLoad = false}>Back</button>
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
    max-width: 400px;
    width: 90%;
  }

  h2 {
    margin-top: 0;
    text-align: center;
  }

  .menu-items {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .menu-items button {
    background: #444;
    color: white;
    border: none;
    padding: 1rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1rem;
    transition: background 0.2s;
  }

  .menu-items button:hover {
    background: #555;
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
</style>
