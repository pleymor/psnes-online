<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { Game } from '$lib/stores/games';

  export let game: Game;
  /** No click while a game of mine is already running: the server would refuse it. */
  export let playDisabled = false;
  export let roomDisabled = false;
  /** « Jouer », or « Jouer avec Bob »: the button says which of the two it is. */
  export let playLabel = '';

  const dispatch = createEventDispatcher();

  /**
   * Cliquer un jeu le lance.
   *
   * C'était l'inverse : le clic ouvrait la fiche et « Jouer » était un bouton
   * parmi trois, sur chacune des cartes. Vingt-sept boutons pour neuf jeux,
   * dont une action destructrice en permanence à l'écran, et la jaquette -
   * la seule belle chose de la page - réduite à une vignette rognée entre eux.
   *
   * Le modèle est maintenant celui d'une étagère : la jaquette est la carte,
   * et on clique un jeu pour y jouer. Le reste vit dans la fiche, qui s'ouvre
   * par l'affordance discrète en coin - un bouton visible en permanence, et
   * non un survol, parce qu'un téléphone ne survole rien.
   */
  function handleCardClick() {
    if (playDisabled) return;
    dispatch('play');
  }

  function openDetails(event: Event) {
    event.stopPropagation();
    dispatch('details');
  }

  function handleKeyPress(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleCardClick();
    }
  }

  /**
   * Une jaquette qui ne charge pas montrait son texte alternatif brut sur du
   * gris. Le titre en Silkscreen sur une tuile sombre est déjà ce qu'est une
   * étiquette de cartouche, et ne ressemble pas à une panne.
   */
  let coverBroken = false;
  $: if (game.coverUrl) coverBroken = false;
</script>

<!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
<div
  class="game-card"
  class:unplayable={playDisabled}
  role="button"
  tabindex="0"
  title={playLabel || t($language, 'play')}
  aria-label={playLabel || t($language, 'play')}
  on:click={handleCardClick}
  on:keypress={handleKeyPress}
>
  <div class="cover">
    {#if game.coverUrl && !coverBroken}
      <img src={game.coverUrl} alt="" on:error={() => (coverBroken = true)} />
    {:else}
      <!-- Le titre EST l'étiquette : c'est ce qu'une cartouche sans jaquette
           montre, et c'est plus utile qu'une manette générique. -->
      <div class="label-only"><span>{game.title}</span></div>
    {/if}

    {#if !game.crc32}
      <!-- Added back when ROMs were stored online, so nothing here can find
           the file yet. Says so on the card rather than only at launch. -->
      <div class="badge needs-rom" title={t($language, 'linkRomExplain')}>
        {t($language, 'needsRom')}
      </div>
    {/if}
    {#if game.needsIdentification && game.crc32}
      <!-- Only when a checksum exists: without one there is nothing to
           identify yet, and "ROM to locate" is the truer thing to say. The two
           badges sit on opposite corners because a card can carry both. -->
      <div class="badge needs-identification" title={t($language, 'identifyExplain')}>
        {t($language, 'needsIdentification')}
      </div>
    {/if}

    <!-- Visible en permanence et non au survol : un téléphone ne survole
         rien, et c'est le seul chemin vers le salon et la suppression. -->
    <button
      class="details"
      on:click={openDetails}
      aria-label={t($language, 'clickForDetails')}
      title={t($language, 'clickForDetails')}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor"
           stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 7.2v4M8 4.9v.1" />
      </svg>
    </button>

    <div class="play-hint"><span>{playLabel || t($language, 'play')}</span></div>
  </div>

  <div class="info">
    <h2>{game.title}</h2>
    <!-- Le compte seulement s'il y en a. « 0 sauvegardes » neuf fois de suite
         n'apprenait rien et occupait une ligne sur chaque carte. -->
    {#if (game.saves?.length ?? 0) > 0}
      <p class="saves">{t($language, 'saveStatesCount', { count: game.saves.length })}</p>
    {/if}
  </div>
</div>

<style>
  /*
   * L'étagère de cartouches, pas le tableau de bord.
   *
   * La jaquette est la carte : format portrait réel, jamais rognée - la
   * grille précédente en imposait un cadrage paysage, et « SUPER NINTENDO »
   * se retrouvait coupé en bas de chacune. Angles à zéro et pas d'ombre
   * douce : une cartouche est un rectangle, et le kit de cartes arrondies
   * grises était précisément ce qui rendait la page anonyme.
   *
   * La palette est celle de la console, pas un « rétro » de catalogue :
   * Les couleurs viennent des jetons de `+layout.svelte`, eux-mêmes tirés
   * de `static/icon.svg` : la coque crème de la cartouche, ses stries, son
   * étiquette violette. J'avais d'abord inventé un lavande, alors que
   * l'application avait déjà sa couleur de marque.
   */
  /* La boîte à message de Super Mario World : fond crème, bord d'encre
     épais, et une ombre portée DURE d'un seul décalage - pas un halo flou.
     C'est la différence entre un objet posé sur un décor et une carte de
     tableau de bord ; le flou gris était précisément le kit générique. */
  .game-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    background: var(--shell);
    border: 3px solid var(--ink);
    border-radius: 8px;
    padding: 5px;
    box-shadow: 0 3px 0 rgba(0, 0, 0, 0.22);
    cursor: pointer;
    /* Le focus clavier doit se voir : la carte entière est un contrôle. */
    outline-offset: 3px;
  }

  .game-card:focus-visible {
    outline: 2px solid var(--brand-lift);
  }

  .game-card.unplayable {
    cursor: default;
    opacity: 0.55;
  }

  .cover {
    position: relative;
    /* Mesuré, pas supposé : les jaquettes du catalogue font 512x357 et
       512x364, soit 1,434 et 1,407 - des scans PAYSAGE, boîte et tranche
       comprises. Un 3/4 portrait laissait deux bandes vides énormes ; 10/7
       (1,428) tombe entre les deux mesures et le cadre disparaît. */
    aspect-ratio: 10 / 7;
    /* Le fond reste sombre derrière une jaquette en `contain` : deux bandes
       crème autour d'un scan sombre feraient flotter l'image. */
    background: var(--ground);
    border: 2px solid var(--ink);
    border-radius: 4px;
    overflow: hidden;
  }

  /* `contain` et non `cover` : ne jamais rogner une jaquette est tout
     l'objet de cette reprise. Une boîte qui n'est pas exactement au format
     laisse deux bandes, ce qui est le moindre mal. */
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  .label-only {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: linear-gradient(180deg, var(--panel), var(--ground));
  }

  .label-only span {
    font-family: 'Silkscreen', monospace;
    font-size: 0.72rem;
    line-height: 1.7;
    color: var(--ridge);
    text-align: center;
  }

  .badge {
    position: absolute;
    top: 0;
    left: 0;
    padding: 0.2rem 0.45rem;
    font-family: 'Silkscreen', monospace;
    font-size: 0.6rem;
    background: var(--ground);
    border: 1px solid var(--edge);
    color: var(--label);
  }

  .needs-identification {
    top: auto;
    bottom: 0;
    color: #f0c020;
  }

  .needs-rom {
    color: #e4353d;
  }

  .details {
    position: absolute;
    top: 0.35rem;
    right: 0.35rem;
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    background: rgba(19, 19, 25, 0.85);
    border: 1px solid var(--edge);
    color: var(--ridge);
    cursor: pointer;
  }

  .details:hover,
  .details:focus-visible {
    color: var(--label);
    border-color: var(--brand-lift);
  }

  /* Le seul mouvement de la page, et il répond à un geste : ce que fait un
     clic, dit au moment où l'on vise. */
  .play-hint {
    position: absolute;
    inset: auto 0 0 0;
    padding: 0.4rem 0.5rem;
    background: rgba(19, 19, 25, 0.93);
    border-top: 1px solid var(--brand);
    opacity: 0;
    transition: opacity 0.12s;
  }

  .game-card:hover .play-hint,
  .game-card:focus-visible .play-hint {
    opacity: 1;
  }

  .game-card.unplayable .play-hint {
    display: none;
  }

  .play-hint span {
    font-family: 'Silkscreen', monospace;
    font-size: 0.62rem;
    color: var(--label);
  }

  @media (prefers-reduced-motion: reduce) {
    .play-hint {
      transition: none;
    }
  }

  .info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0 0.1rem;
  }

  /* Silkscreen en petit titre seulement. En paragraphe elle serait
     illisible, et le corps de texte reste en sans système. */
  /* Ni Silkscreen ni Pixelify : le sans système, et c'est mesuré.
     Silkscreen à 0,68 rem donnait des titres à deviner. Pixelify, essayée
     ensuite, ferme tellement son C à 13 px qu'une capture montrait
     « Ohrono Trigger » et « Donkey Kong Oountry » - un titre de jeu est la
     seule chose de cette page qu'il faut lire sans effort, et c'est aussi
     le texte le plus répété à l'écran. Les deux polices pixel restent sur
     le décor, qui porte des mots courts et connus d'avance. */
  .info h2 {
    margin: 0;
    font-size: 0.82rem;
    font-weight: 600;
    line-height: 1.35;
    color: var(--ink);
  }

  .saves {
    margin: 0;
    font-size: 0.76rem;
    color: var(--ink-2);
  }
</style>
