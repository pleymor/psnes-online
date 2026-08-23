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
  import { fetchSaves, deleteSave, byNewest, type SaveSummary, type LoadFailure } from '$lib/saves/api';
  import { saveIdentity } from '$lib/saves/identity';
  import ConfirmModal from './ConfirmModal.svelte';
  import { notifications } from '$lib/services/notification';

  export let gameId: string;
  /** Shown on each tile's action button - "load" or "overwrite". */
  export let actionLabel: string;
  export let busy = false;

  const dispatch = createEventDispatcher<{ select: SaveSummary }>();

  let saves: SaveSummary[] = [];
  let failure: LoadFailure | null = null;
  let loading = true;

  /*
   * Deleting lives here rather than in the two menus above.
   *
   * This component owns the list and its reload, and both menus must behave
   * identically; putting the confirmation, the call and the refresh in each of
   * them would be two copies of one behaviour to keep in step.
   */
  let pendingDelete: SaveSummary | null = null;
  let deleting = false;

  async function confirmDelete() {
    const target = pendingDelete;
    pendingDelete = null;
    if (!target) return;

    deleting = true;
    const result = await deleteSave(gameId, target.id);
    deleting = false;

    /*
     * Straight to the store, not up through an event.
     *
     * The menus above dispatch `notification` to a room that never listened, so
     * anything sent that way is never seen. The toast is mounted once in the
     * root layout, which is also what a deletion needs: the pause menu can be
     * closed before the answer arrives.
     */
    if (!result.ok) {
      notifications.show(t($language, result.reason), 'error');
      // Reloaded even on failure: the usual reason a delete is refused is that
      // the save is already gone, and leaving it on screen invites the player
      // to try again for ever.
      await reload();
      return;
    }

    notifications.show(t($language, 'saveDeleted'), 'success');
    await reload();
  }

  export async function reload() {
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
      {@const identity = saveIdentity(save, $language, t($language, 'quickSave'))}
      <!-- A row holding two buttons rather than one big button: a delete
           control cannot be nested inside the button it sits on. -->
      <li class="tile">
        <button class="pick" disabled={busy} on:click={() => dispatch('select', save)}>
          <span class="shot">
            {#if save.screenshot}
              <img src={save.screenshot} alt="" />
            {:else}
              <span class="shot-missing" aria-hidden="true">?</span>
            {/if}
          </span>
          <span class="meta">
            <strong>{identity.primary}</strong>
            {#if identity.secondary}
              <small>{identity.secondary}</small>
            {/if}
          </span>
          <span class="action">{actionLabel}</span>
        </button>
        <button
          class="remove"
          disabled={busy || deleting}
          title={t($language, 'deleteSave')}
          aria-label={`${t($language, 'deleteSave')} — ${identity.primary}`}
          on:click={() => (pendingDelete = save)}
        >
          ×
        </button>
      </li>
    {/each}
  </ul>
{/if}

{#if pendingDelete}
  <ConfirmModal
    title={t($language, 'deleteSave')}
    message={t($language, 'confirmDeleteSave').replace(
      '{name}',
      saveIdentity(pendingDelete, $language, t($language, 'quickSave')).primary
    )}
    confirmText={t($language, 'deleteSave')}
    danger={true}
    on:confirm={confirmDelete}
    on:cancel={() => (pendingDelete = null)}
  />
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
    /* Reserved whether or not it is showing, so a tile's width stops depending
       on how many saves there are - fifteen pixels that only disappear once the
       list is short, which is not when the layout needs testing. */
    scrollbar-gutter: stable;
    /* Queried by the tile below rather than inherited from a parent: only one
       of the two menus wrapping this component declares a container, and an
       element that depends on a property just one of its parents has is an
       element that breaks in exactly one place. */
    container-type: inline-size;
  }

  /* The row. It used to be the button itself; the delete control had to become
     a sibling, because a button cannot live inside a button. */
  .tile {
    display: flex;
    align-items: stretch;
    background: #252525;
    border: 1px solid transparent;
    border-radius: 6px;
  }

  .tile:has(.pick:hover:not(:disabled)) {
    background: #2f2f2f;
    border-color: #667eea;
  }

  .pick {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    background: none;
    border: none;
    border-radius: 6px 0 0 6px;
    cursor: pointer;
    text-align: left;
    color: inherit;
    font: inherit;
  }

  .pick:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Deliberately quiet, and deliberately not red until it is hovered: it sits
     next to the action the player actually came for, and a permanent red cross
     would pull the eye to the one control that cannot be undone. */
  .remove {
    flex: 0 0 auto;
    align-self: stretch;
    padding: 0 0.7rem;
    background: none;
    border: none;
    border-radius: 0 6px 6px 0;
    color: #6b6b6b;
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
  }

  .remove:hover:not(:disabled) {
    background: #3a2626;
    color: #e06060;
  }

  .remove:disabled {
    opacity: 0.4;
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

  /* The same containment the name has always had.
     Without it this line wrapped at the space between date and time, and the
     "23/08/2026" half - which has no break opportunity of its own - overflowed
     the box and painted itself across the action label. This is the guarantee:
     whatever the widths do afterwards, nothing here can bleed again. */
  .meta small {
    color: #888;
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .action {
    flex: 0 0 auto;
    color: #667eea;
    font-size: 0.8125rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /*
   * The narrow panel, which is where this list actually lives.
   *
   * Docked to the left of the game, the pause panel is 20rem: about 200px of
   * tile once four levels of padding and the scrollbar are paid for. A fixed
   * 96px thumbnail and an action label side by side left twenty of those for
   * the text. Shrinking the picture and dropping the action onto its own line
   * gives the words about 140px instead.
   */
  @container (max-width: 22rem) {
    .pick {
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .shot {
      width: 56px;
      height: 42px;
    }

    .action {
      flex-basis: 100%;
      text-align: right;
    }
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
