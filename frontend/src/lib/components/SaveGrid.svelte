<script lang="ts">
  /**
   * The list of a game's saves, with its thumbnails and its failures.
   *
   * Both save menus show the same list and differ only in what selecting one
   * means, so the list - and in particular its handling of a failed read -
   * lives here once. The empty list and the unread list are different states:
   * showing "no saves yet" when the truth was "could not ask" is what cost a
   * savestate the last time this screen guessed.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { fetchSaves, byNewest, type SaveSummary, type LoadFailure } from '$lib/saves/api';

  export let gameId: string;
  /** Shown on each tile's action button - "load" or "overwrite". */
  export let actionLabel: string;
  export let busy = false;
  /**
   * Saves the caller already holds, if it does.
   *
   * The library gets summaries with every game from `/api/games`, blob-free.
   * Asking `/api/games/:id/saves` for them again would download the savestates
   * themselves - about a megabyte each - to draw a list of thumbnails, on a
   * screen a player opens out of curiosity. So the caller may hand them over
   * and this grid will not fetch.
   */
  export let preloaded: SaveSummary[] | null = null;

  const dispatch = createEventDispatcher<{ select: SaveSummary }>();

  let saves: SaveSummary[] = [];
  let failure: LoadFailure | null = null;
  let loading = true;

  export async function reload() {
    // Nothing to reload when the caller owns the list: there was no request to
    // fail, so there is no retry to offer either.
    if (preloaded) {
      saves = byNewest(preloaded);
      failure = null;
      loading = false;
      return;
    }

    loading = true;
    const result = await fetchSaves(gameId);
    loading = false;

    if (result.ok) {
      saves = byNewest(result.saves);
      failure = null;
      return;
    }

    failure = result.reason;
    saves = [];
  }

  onMount(reload);

  // A preloaded list can be replaced under us - the library reloads after a
  // save is written - so follow it rather than only reading it once at mount.
  $: if (preloaded) {
    saves = byNewest(preloaded);
    failure = null;
    loading = false;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString($language);
  }
</script>

{#if loading}
  <p class="grid-note">{t($language, 'loading')}</p>
{:else if failure}
  <p class="grid-error">
    {t($language, failure)}
    <button class="btn-retry" on:click={reload}>{t($language, 'retry')}</button>
  </p>
{:else if saves.length === 0}
  <p class="grid-note">{t($language, 'noSaves')}</p>
{:else}
  <ul class="grid">
    {#each saves as save (save.id)}
      <li>
        <button class="tile" disabled={busy} on:click={() => dispatch('select', save)}>
          <span class="shot">
            {#if save.screenshot}
              <img src={save.screenshot} alt="" />
            {:else}
              <span class="shot-missing" aria-hidden="true">?</span>
            {/if}
          </span>
          <span class="meta">
            <strong>{save.name}</strong>
            <small>{formatDate(save.updatedAt)}</small>
          </span>
          <span class="action">{actionLabel}</span>
        </button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 380px;
    overflow-y: auto;
  }

  .tile {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    background: #252525;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
  }

  .tile:hover:not(:disabled) {
    background: #2f2f2f;
    border-color: #667eea;
  }

  .tile:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .shot {
    flex: 0 0 auto;
    width: 96px;
    height: 72px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #111;
    border-radius: 4px;
    overflow: hidden;
  }

  .shot img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    /* A 128px-wide thumbnail of a 256px frame: keep the pixels crisp. */
    image-rendering: pixelated;
  }

  .shot-missing {
    color: #555;
    font-size: 1.5rem;
  }

  .meta {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .meta strong {
    color: white;
    font-size: 0.9375rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta small {
    color: #888;
    font-size: 0.75rem;
  }

  .action {
    flex: 0 0 auto;
    color: #667eea;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .grid-note {
    text-align: center;
    color: #666;
    padding: 2rem 0;
    margin: 0;
  }

  .grid-error {
    color: #e0a33e;
    font-size: 0.875rem;
    line-height: 1.5;
    text-align: center;
    padding: 1.5rem 0.5rem;
    margin: 0;
  }

  .btn-retry {
    display: block;
    margin: 0.75rem auto 0;
    background: #444;
    color: white;
    border: none;
    padding: 0.4rem 0.9rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.8125rem;
  }

  .btn-retry:hover {
    background: #555;
  }
</style>
