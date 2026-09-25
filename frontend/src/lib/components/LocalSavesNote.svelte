<script lang="ts">
  /**
   * Where the saves of solo play without an account go, said once.
   *
   * The fallback to this browser is silent in game by decision (#70 §4.2): a
   * game without a file next to its ROM is better than no game. Silent in game
   * does not mean hidden, and this line is where the ROM panel says it - the
   * profile's panel and the one on the home page without an account alike.
   */
  import { onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { saveNoteKey, type SaveNoteKey } from '$lib/saves/local-rules';
  import { browserSaveFolder } from '$lib/saves/local-store';

  /** Bump it after a gesture that may have changed the folder or its permission. */
  export let refresh = 0;

  let key: SaveNoteKey | null = null;

  async function gather(): Promise<void> {
    try {
      key = saveNoteKey(await browserSaveFolder().facts());
    } catch {
      key = 'localSavesNoFolder';
    }
  }

  onMount(gather);
  $: if (refresh) void gather();
</script>

{#if key}
  <p class="saves-note" data-note={key}>
    <strong>{t($language, 'localSavesPrefix')}</strong>
    {t($language, key)}
  </p>
{/if}

<style>
  .saves-note {
    margin: 0;
    color: #aaa;
    font-size: 0.9rem;
  }
</style>
