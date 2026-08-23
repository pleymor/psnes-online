<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { Game } from '$lib/stores/games';

  export let game: Game;

  const dispatch = createEventDispatcher();

  async function deleteGame(event: Event) {
    event.stopPropagation();
    dispatch('delete');
  }

  function handleCardClick() {
    dispatch('details');
  }

  function handlePlayClick(event: Event) {
    event.stopPropagation();
    dispatch('play');
  }

  function handleKeyPress(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleCardClick();
    }
  }
</script>

<div
  class="game-card"
  role="button"
  tabindex="0"
  on:click={handleCardClick}
  on:keypress={handleKeyPress}
>
  <div class="cover">
    {#if game.coverUrl}
      <img src={game.coverUrl} alt={game.title} />
    {:else}
      <div class="placeholder">🎮</div>
    {/if}
    {#if !game.crc32}
      <!-- Added back when ROMs were stored online, so nothing here can find
           the file yet. Says so on the card rather than only at launch. -->
      <div class="needs-rom" title={t($language, 'linkRomExplain')}>
        {t($language, 'needsRom')}
      </div>
    {/if}
    {#if game.needsIdentification && game.crc32}
      <!-- Only when a checksum exists: without one there is nothing to
           identify yet, and "ROM to locate" is the truer thing to say. The two
           badges sit on opposite corners because a card can carry both. -->
      <div class="needs-identification" title={t($language, 'identifyExplain')}>
        {t($language, 'needsIdentification')}
      </div>
    {/if}
    <div class="hover-overlay">
      <div class="info-icon">ℹ️</div>
      <div class="info-text">{t($language, 'clickForDetails')}</div>
    </div>
  </div>

  <div class="info">
    <h3>{game.title}</h3>
    {#if game.genre}
      <p class="genre">{game.genre}</p>
    {/if}
    <p class="saves">{t($language, 'saveStatesCount', { count: game.saves?.length || 0 })}</p>
  </div>

  <div class="actions">
    <button on:click={handlePlayClick} class="btn-play">
      {t($language, 'play')}
    </button>
    <button on:click={deleteGame} class="btn-delete">
      {t($language, 'delete')}
    </button>
  </div>
</div>

<style>
  .needs-identification {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 2;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    background: rgba(102, 126, 234, 0.92);
    color: #fff;
    font-size: 0.68rem;
    font-weight: 600;
  }

  .needs-rom {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    z-index: 2;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    background: rgba(234, 179, 8, 0.9);
    color: #201a00;
    font-size: 0.68rem;
    font-weight: 600;
  }

  .game-card {
    background: rgba(42, 42, 42, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 16px;
    overflow: hidden;
    transition: all 0.3s ease;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .game-card:hover {
    transform: translateY(-8px);
    box-shadow: 0 12px 24px rgba(0, 0, 0, 0.3);
    border-color: rgba(102, 126, 234, 0.3);
  }

  .cover {
    aspect-ratio: 16/9;
    background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%);
    display: flex;
    justify-content: center;
    align-items: center;
    position: relative;
    overflow: hidden;
  }

  .cover::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(102, 126, 234, 0.1) 0%, rgba(118, 75, 162, 0.1) 100%);
    opacity: 0;
    transition: opacity 0.3s;
  }

  .game-card:hover .cover::before {
    opacity: 1;
  }

  .hover-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.3s;
    gap: 0.5rem;
  }

  .game-card:hover .hover-overlay {
    opacity: 1;
  }

  .info-icon {
    font-size: 2.5rem;
  }

  .info-text {
    font-size: 0.875rem;
    color: #fff;
    font-weight: 500;
  }

  .placeholder {
    font-size: 3rem;
    opacity: 0.4;
  }

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .info {
    padding: 1.25rem;
    flex-grow: 1;
  }

  h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: #fff;
  }

  .genre {
    margin: 0 0 0.25rem 0;
    color: #667eea;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .saves {
    margin: 0;
    color: #999;
    font-size: 0.875rem;
  }

  .actions {
    padding: 0 1.25rem 1.25rem;
    display: flex;
    gap: 0.75rem;
  }

  .btn-play {
    flex: 1;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 0.875rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.9375rem;
    font-weight: 500;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .btn-play:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  }

  .btn-delete {
    background: rgba(68, 68, 68, 0.8);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 0.875rem 1rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.9375rem;
    transition: all 0.2s;
  }

  .btn-delete:hover {
    background: rgba(200, 50, 50, 0.8);
    border-color: rgba(200, 50, 50, 0.3);
  }
</style>
