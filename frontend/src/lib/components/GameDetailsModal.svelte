<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { Game } from '$lib/stores/games';
  import SaveGrid from './SaveGrid.svelte';
  import type { SaveSummary } from '$lib/saves/api';
  import { downloadArchive } from '$lib/saves/portability';
  import type { TranslationKey } from '$lib/i18n/translations';

  export let game: Game;

  const dispatch = createEventDispatcher();

  /**
   * The saves as the library already knows them.
   *
   * `/api/games` carries a summary per slot - name, thumbnail, timestamps -
   * with the savestate left behind, so this screen needs no request of its own.
   */
  $: saves = (game.saves ?? []) as SaveSummary[];

  function close() {
    dispatch('close');
  }

  /**
   * The other unit a player wants: one game, to hand to a friend who has the
   * same cartridge. Same endpoint and same file format as the whole-library
   * export on the profile page - a single game is a list of one - so there is
   * one thing to import, not two.
   */
  let exporting = false;
  let exportError = '';
  async function exportSaves() {
    exporting = true;
    exportError = '';
    const result = await downloadArchive({ gameId: game.id });
    if (!result.ok) exportError = t($language, result.reason as TranslationKey);
    exporting = false;
  }

  function formatDate(dateString?: string): string {
    if (!dateString) return t($language, 'unknown');
    try {
      const date = new Date(dateString);
      const locale = $language === 'fr' ? 'fr-FR' : 'en-US';
      return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return dateString;
    }
  }

  function handleKeyPress(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      close();
    }
  }
</script>

<div class="modal-overlay" role="dialog" aria-modal="true" on:click={close} on:keydown={handleKeyPress}>
  <div class="modal-content" role="document" on:click|stopPropagation>
    <button class="close-btn" on:click={close}>×</button>

    <div class="modal-grid">
      <div class="cover-section">
        {#if game.coverUrl}
          <img src={game.coverUrl} alt={game.title} class="cover-image" />
        {:else}
          <div class="cover-placeholder">
            <div class="placeholder-icon">🎮</div>
          </div>
        {/if}
      </div>

      <div class="details-section">
        <h2 class="title">{game.title}</h2>

        {#if game.description}
          <p class="description">{game.description}</p>
        {/if}

        <div class="metadata-grid">
          {#if game.genre}
            <div class="metadata-item">
              <span class="label">{t($language, 'genre')}</span>
              <span class="value">{game.genre}</span>
            </div>
          {/if}

          {#if game.publisher}
            <div class="metadata-item">
              <span class="label">{t($language, 'publisher')}</span>
              <span class="value">{game.publisher}</span>
            </div>
          {/if}

          {#if game.developer}
            <div class="metadata-item">
              <span class="label">{t($language, 'developer')}</span>
              <span class="value">{game.developer}</span>
            </div>
          {/if}

          {#if game.releaseDate}
            <div class="metadata-item">
              <span class="label">{t($language, 'releaseDate')}</span>
              <span class="value">{formatDate(game.releaseDate)}</span>
            </div>
          {/if}

          {#if game.players}
            <div class="metadata-item">
              <span class="label">{t($language, 'players')}</span>
              <span class="value">{game.players}</span>
            </div>
          {/if}

          {#if game.region}
            <div class="metadata-item">
              <span class="label">{t($language, 'region')}</span>
              <span class="value">{game.region}</span>
            </div>
          {/if}

          <div class="metadata-item">
            <span class="label">{t($language, 'saveStates')}</span>
            <span class="value">{game.saves?.length || 0}</span>
          </div>

          <div class="metadata-item">
            <span class="label">{t($language, 'uploaded')}</span>
            <span class="value">{formatDate(game.uploadedAt)}</span>
          </div>
        </div>

        <div class="filename-section">
          <span class="label">{t($language, 'romFile')}</span>
          <span class="filename">{game.filename}</span>
        </div>

        {#if game.crc32 && saves.length > 0}
          <!--
            Starting from a save, rather than starting and then loading one.
            The grid is handed its list rather than asked to fetch: /api/games
            already carried these summaries here without the savestates
            themselves, which are about a megabyte each.
          -->
          <section class="resume">
            <h3>{t($language, 'resumeAGame')}</h3>
            <SaveGrid
              gameId={game.id}
              preloaded={saves}
              actionLabel={t($language, 'resumeFromHere')}
              on:select={(e) => dispatch('resume', e.detail.id)}
              on:deleted
            />
          </section>
        {/if}

        {#if game.crc32}
          <!-- Always offered once there is a checksum to claim, not only when
               the game is unknown: a sparse entry is worth completing too. -->
          <button class="identify" on:click={() => dispatch('identify')}>
            {game.needsIdentification
              ? t($language, 'identifyGame')
              : t($language, 'completeEntry')}
          </button>
        {/if}

        {#if game.crc32 && (saves.length > 0 || game.sramUpdatedAt)}
          <!-- Only once there is something to carry. An empty file offered
               beside a game with no progress is an invitation to think
               something was lost. -->
          <button class="export-saves" on:click={exportSaves} disabled={exporting}>
            {exporting ? t($language, 'exporting') : t($language, 'exportThisGame')}
          </button>
          {#if exportError}<p class="export-error">{exportError}</p>{/if}
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .export-saves {
    margin-top: 0.5rem;
    width: 100%;
  }

  .export-error {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: #ff8a80;
  }

  .resume {
    margin-top: 1.25rem;
  }

  .resume h3 {
    margin: 0 0 0.5rem;
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9aa0b4;
  }

  .identify {
    margin-top: 1rem;
    align-self: flex-start;
    background: transparent;
    border: 1px solid #3d3d52;
    color: #b7b7cc;
    border-radius: 6px;
    padding: 0.45rem 1rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .identify:hover {
    border-color: #667eea;
    color: #fff;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2000;
    padding: 2rem;
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
    background: linear-gradient(135deg, #1e1e1e 0%, #2a2a2a 100%);
    border-radius: 24px;
    max-width: 900px;
    width: 100%;
    max-height: 90vh;
    overflow-y: auto;
    position: relative;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.1);
    animation: slideUp 0.3s ease-out;
  }

  @keyframes slideUp {
    from {
      transform: translateY(30px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .close-btn {
    position: absolute;
    top: 1.5rem;
    right: 1.5rem;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: white;
    font-size: 1.75rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    z-index: 10;
    line-height: 1;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.2);
    transform: rotate(90deg);
  }

  .modal-grid {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 2.5rem;
    padding: 2.5rem;
  }

  .cover-section {
    position: sticky;
    top: 0;
  }

  .cover-image {
    width: 100%;
    border-radius: 16px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .cover-placeholder {
    aspect-ratio: 3/4;
    background: linear-gradient(135deg, #2a2a2a 0%, #1a1a1a 100%);
    border-radius: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  .placeholder-icon {
    font-size: 5rem;
    opacity: 0.3;
  }

  .details-section {
    min-width: 0;
  }

  .title {
    font-size: 2.25rem;
    margin: 0 0 1.5rem 0;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    font-weight: 700;
    line-height: 1.2;
  }

  .description {
    font-size: 1.125rem;
    line-height: 1.7;
    color: #ccc;
    margin: 0 0 2rem 0;
    padding: 1.5rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 12px;
    border-left: 3px solid #667eea;
  }

  .metadata-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1.5rem;
    margin-bottom: 2rem;
  }

  .metadata-item {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .label {
    font-size: 0.875rem;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 500;
  }

  .value {
    font-size: 1.125rem;
    color: #fff;
    font-weight: 500;
  }

  .filename-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1.5rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  .filename {
    font-family: monospace;
    color: #aaa;
    font-size: 0.9375rem;
    word-break: break-all;
  }

  @media (max-width: 768px) {
    .modal-grid {
      grid-template-columns: 1fr;
      gap: 2rem;
      padding: 2rem;
    }

    .cover-section {
      position: static;
    }

    .cover-image,
    .cover-placeholder {
      max-width: 320px;
      margin: 0 auto;
    }

    .title {
      font-size: 1.75rem;
    }

    .metadata-grid {
      grid-template-columns: 1fr;
      gap: 1.25rem;
    }
  }

  /* Custom scrollbar */
  .modal-content::-webkit-scrollbar {
    width: 8px;
  }

  .modal-content::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
  }

  .modal-content::-webkit-scrollbar-thumb {
    background: rgba(102, 126, 234, 0.5);
    border-radius: 4px;
  }

  .modal-content::-webkit-scrollbar-thumb:hover {
    background: rgba(102, 126, 234, 0.7);
  }
</style>
