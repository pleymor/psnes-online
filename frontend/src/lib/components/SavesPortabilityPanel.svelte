<script lang="ts">
  /**
   * Taking your progress with you.
   *
   * On the profile page rather than in the library, next to the ROM folder
   * panel: both answer the same question - what of mine lives where - and a
   * player who has just discovered their ROMs are local is the player most
   * likely to wonder where their saves are.
   *
   * Two things it must say out loud, because both are the kind of silence that
   * loses somebody an evening: that an import never overwrites a savestate
   * (they are renumbered into free slots), and that the single battery save per
   * cartridge is the one exception, which is why it has a checkbox of its own.
   */
  import { language } from '$lib/stores/language';
  import { t, type TranslationKey } from '$lib/i18n/translations';
  import {
    downloadArchive,
    uploadArchive,
    parseArchiveText,
    importSummary,
    type SummaryLine
  } from '$lib/saves/portability';
  import { loadGames } from '$lib/stores/games';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('SavesPortability');

  let screenshots = true;
  let replaceSram = false;
  let busy: '' | 'export' | 'import' = '';
  let error = '';
  let lines: SummaryLine[] = [];
  let fileInput: HTMLInputElement;

  async function exportAll(): Promise<void> {
    busy = 'export';
    error = '';
    lines = [];
    const result = await downloadArchive({ screenshots });
    if (!result.ok) error = t($language, result.reason as TranslationKey);
    busy = '';
  }

  /**
   * A summary line's sentence.
   *
   * A function rather than a cast in the markup: Svelte's template parser is
   * not TypeScript and chokes on `as`. The keys are the server's seven
   * outcomes, all of them declared in `translations.ts`.
   */
  function label(line: SummaryLine): string {
    return t($language, line.key as TranslationKey, { count: line.count });
  }

  async function onFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared straight away so choosing the same file twice still fires a
    // change event - which is exactly what someone does after a failure.
    input.value = '';
    if (!file) return;

    busy = 'import';
    error = '';
    lines = [];
    try {
      const parsed = parseArchiveText(await file.text());
      if (!parsed.ok) {
        error = t($language, parsed.reason as TranslationKey);
        return;
      }
      const result = await uploadArchive(parsed.archive, replaceSram);
      if (!result.ok) {
        error = t($language, result.reason as TranslationKey);
        return;
      }
      lines = importSummary(result.response);
      // A new game row may have appeared, and the library store is what the
      // rest of the app reads. Leaving it stale would show an import that
      // "did nothing" until the next reload.
      await loadGames();
    } catch (e) {
      logger.error('Import failed:', e);
      error = t($language, 'importFailed');
    } finally {
      busy = '';
    }
  }
</script>

<section class="card">
  <h2>{t($language, 'savesPortability')}</h2>
  <p class="note">{t($language, 'savesPortabilityHint')}</p>

  <label class="check">
    <input type="checkbox" bind:checked={screenshots} disabled={busy !== ''} />
    <span>
      {t($language, 'includeScreenshots')}
      <small>{t($language, 'includeScreenshotsHint')}</small>
    </span>
  </label>

  <button on:click={exportAll} disabled={busy !== ''}>
    {busy === 'export' ? t($language, 'exporting') : t($language, 'exportSaves')}
  </button>

  <hr />

  <h3>{t($language, 'importSaves')}</h3>
  <p class="note">{t($language, 'importSavesHint')}</p>

  <label class="check">
    <input type="checkbox" bind:checked={replaceSram} disabled={busy !== ''} />
    <span>
      {t($language, 'replaceSram')}
      <small>{t($language, 'replaceSramHint')}</small>
    </span>
  </label>

  <input
    type="file"
    accept="application/json,.json"
    bind:this={fileInput}
    on:change={onFile}
    hidden
  />
  <button on:click={() => fileInput.click()} disabled={busy !== ''}>
    {busy === 'import' ? t($language, 'importing') : t($language, 'chooseArchive')}
  </button>

  {#if error}<p class="note error">{error}</p>{/if}

  {#if lines.length > 0}
    <ul class="summary">
      {#each lines as line (line.key)}
        <li class:loud={line.key === 'importCoreMismatch'}>
          {label(line)}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  h3 {
    margin: 0 0 0.25rem;
    font-size: 0.95rem;
  }

  hr {
    border: none;
    border-top: 1px solid rgba(255, 255, 255, 0.12);
    margin: 1.25rem 0 1rem;
  }

  .note {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    opacity: 0.75;
    line-height: 1.4;
  }

  .note.error {
    opacity: 1;
    color: #ff8a80;
  }

  .check {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    margin-bottom: 0.75rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .check input {
    margin-top: 0.2rem;
    flex: 0 0 auto;
  }

  .check small {
    display: block;
    opacity: 0.65;
    line-height: 1.35;
  }

  .summary {
    margin: 0.75rem 0 0;
    padding-left: 1.1rem;
    font-size: 0.85rem;
    line-height: 1.5;
  }

  /* The one line that is not bookkeeping: savestates were dropped. */
  .summary li.loud {
    list-style: none;
    margin-left: -1.1rem;
    color: #ffcc66;
  }
</style>
