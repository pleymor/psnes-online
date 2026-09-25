<script lang="ts">
  /**
   * The savestate slots of solo play without an account.
   *
   * Not `SaveGameMenu`/`LoadSavesMenu`: those are named saves on the server,
   * with thumbnails, through `game:save` and `game:load`. Here there is no
   * server, and the saves are files next to the ROM - `<rom>.state1`, `.state2`
   * - so what the player chooses is a slot, the way a console emulator offers
   * it. The store behind it is `saves/local-store.ts`.
   */
  import { onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { STATE_SLOTS } from '$lib/saves/local-rules';
  import type { SaveListing } from '$lib/saves/local-store';

  /** The three verbs a room hands down; the menu knows nothing else about saves. */
  export let slots: {
    list(): Promise<SaveListing[]>;
    save(slot: number): Promise<boolean>;
    load(slot: number): Promise<boolean>;
  };

  let listed = new Map<number, SaveListing>();
  let busy = false;
  let message = '';
  let failed = false;

  const numbers = Array.from({ length: STATE_SLOTS }, (_, i) => i + 1);

  async function refresh(): Promise<void> {
    const found = await slots.list().catch(() => [] as SaveListing[]);
    listed = new Map(
      found.filter((s) => typeof s.slot === 'number').map((s) => [s.slot as number, s])
    );
  }

  function when(savedAt: number): string {
    return new Date(savedAt).toLocaleString($language === 'fr' ? 'fr-FR' : 'en-GB', {
      dateStyle: 'short',
      timeStyle: 'short'
    });
  }

  async function act(kind: 'save' | 'load', slot: number): Promise<void> {
    busy = true;
    message = '';
    try {
      const ok = kind === 'save' ? await slots.save(slot) : await slots.load(slot);
      failed = !ok;
      message = ok
        ? t($language, kind === 'save' ? 'localSaved' : 'localLoaded', { n: slot })
        : t($language, 'localSaveFailed');
      if (kind === 'save') await refresh();
    } finally {
      busy = false;
    }
  }

  onMount(refresh);
</script>

<h3>{t($language, 'localSaves')}</h3>
<ul class="slots">
  {#each numbers as n}
    {@const entry = listed.get(n)}
    <li class="slot" data-slot={n}>
      <span class="name">{t($language, 'localSlot', { n })}</span>
      <span class="when">{entry ? when(entry.savedAt) : t($language, 'localSlotEmpty')}</span>
      <button disabled={busy} on:click={() => act('save', n)}>{t($language, 'localSaveHere')}</button>
      <button disabled={busy || !entry} on:click={() => act('load', n)}>{t($language, 'localLoadHere')}</button>
    </li>
  {/each}
</ul>
{#if message}
  <p class="message" class:failed role="status">{message}</p>
{/if}

<style>
  .slots {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .slot {
    display: grid;
    grid-template-columns: 1fr auto auto;
    grid-template-areas: 'name save load' 'when save load';
    align-items: center;
    gap: 0.1rem 0.5rem;
  }

  .name {
    grid-area: name;
    font-family: var(--display);
  }

  .when {
    grid-area: when;
    font-size: 0.8rem;
    color: var(--muted);
  }

  .slot button:first-of-type {
    grid-area: save;
  }

  .slot button:last-of-type {
    grid-area: load;
  }

  .message {
    margin: 0 0 0.75rem;
    font-size: 0.9rem;
  }

  .message.failed {
    color: #ff9b8a;
  }
</style>
