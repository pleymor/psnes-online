<script lang="ts">
  /**
   * Asks the player to point at a ROM the app could not find on its own.
   *
   * This appears when the automatic paths came up empty: no folder picked yet,
   * a browser without the directory API, or a guest who has the game under a
   * name nobody could have guessed. It is also the last line of defence
   * against the wrong file - the checksum is recomputed here, so a mismatch is
   * caught while the player is still in front of the picker rather than three
   * seconds into a desynchronising match.
   */
  import { createEventDispatcher } from 'svelte';
  import { offerFile } from '$lib/roms/provider';
  import { chooseDirectory, supportsDirectoryPicker, storedDirectory, ensureAccess, readRomByChecksum } from '$lib/roms/local-library';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('LocateRom');
  const dispatch = createEventDispatcher<{ found: Uint8Array; cancel: void }>();

  export let checksum: string;
  export let title = '';
  /** Whether leaving without a ROM is an option. In a room, it is not. */
  export let cancellable = false;

  const ACCEPT = '.smc,.sfc,.fig,.swc,.mgd,.zip';

  let fileInput: HTMLInputElement;
  let error = '';
  let busy = false;

  async function onFileChosen(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    busy = true;
    error = '';
    try {
      dispatch('found', await offerFile(file, checksum));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.warn('The chosen file did not match', err);
    } finally {
      busy = false;
    }
  }

  /**
   * Picking the folder is offered first because it is the one gesture that
   * pays for itself: every later launch, of any game in it, finds its file
   * without asking.
   */
  async function pickFolder() {
    busy = true;
    error = '';
    try {
      if (!(await chooseDirectory())) return;
      const handle = await storedDirectory();
      if (!handle || !(await ensureAccess(handle))) return;

      const bytes = await readRomByChecksum(handle, checksum);
      if (bytes) {
        dispatch('found', bytes);
      } else {
        error = 'That folder does not contain this game.';
      }
    } catch (err) {
      // An aborted picker is a decision, not a failure.
      if ((err as { name?: string })?.name !== 'AbortError') {
        error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="backdrop" role="presentation">
  <div class="modal" role="dialog" aria-modal="true">
    <h2>Find your copy of {title || 'this game'}</h2>
    <p class="explain">
      ROMs stay on your machine — the server never holds one. Point at the file
      and it will be checked against the one this room is for.
    </p>
    <p class="checksum">CRC32 {checksum}</p>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <input
      bind:this={fileInput}
      type="file"
      accept={ACCEPT}
      class="hidden-input"
      on:change={onFileChosen}
    />

    <div class="actions">
      {#if cancellable}
        <button class="secondary" on:click={() => dispatch('cancel')} disabled={busy}>Cancel</button>
      {/if}
      {#if supportsDirectoryPicker()}
        <button class="secondary" on:click={pickFolder} disabled={busy}>Choose my ROM folder</button>
      {/if}
      <button class="primary" on:click={() => fileInput.click()} disabled={busy}>
        {busy ? 'Checking…' : 'Choose the file'}
      </button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }

  .modal {
    background: #1b1b26;
    border: 1px solid #2c2c3c;
    border-radius: 12px;
    padding: 1.5rem;
    width: 100%;
    max-width: 460px;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  h2 {
    margin: 0;
    font-size: 1.2rem;
    color: #fff;
  }

  .explain {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.5;
    color: #8b8ba3;
  }

  .checksum {
    margin: 0;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: #6f6f88;
  }

  .error {
    margin: 0;
    color: #ff8f8f;
    font-size: 0.85rem;
  }

  .hidden-input {
    display: none;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  button {
    border-radius: 6px;
    padding: 0.5rem 1rem;
    font-size: 0.88rem;
    cursor: pointer;
    border: 1px solid transparent;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .secondary {
    background: transparent;
    border-color: #3d3d52;
    color: #b7b7cc;
  }

  .primary {
    /* Pas le #667eea de la marque : 3.66:1 sous du blanc, sous les 4.5
       qu'AA demande. Même teinte, assombrie jusqu'à 4.96:1. */
    background: #4764e6;
    color: #fff;
  }
</style>
