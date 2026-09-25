<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { Game } from '$lib/stores/games';
  import SaveGrid from './SaveGrid.svelte';
  import type { SaveSummary } from '$lib/saves/api';
  import { downloadArchive } from '$lib/saves/portability';
  import type { TranslationKey } from '$lib/i18n/translations';
  import { grantShareConsent, hasShareConsent } from '$lib/roms/share-consent';
  import type { PreferenceStorage } from '$lib/stores/shader-preference';

  export let game: Game;
  /**
   * Le pseudo de l'ami du groupe, ou vide s'il n'y a pas de groupe.
   *
   * Le bouton d'envoi n'existe que quand il y a quelqu'un à qui envoyer :
   * offrir un jeu à personne n'a pas de sens, et le relais refuserait de
   * toute façon - tout passe par l'appartenance au salon.
   */
  export let partnerName = '';
  /** Une offre pour CE jeu attend déjà une réponse. */
  export let sharePending = false;
  /**
   * Le salon et la suppression, arrivés ici depuis la carte.
   *
   * La grille portait trois boutons par jeu - vingt-sept pour neuf - dont
   * une action destructrice affichée en permanence. La jaquette est la carte
   * maintenant, et cliquer un jeu le lance ; ces deux-là, plus rares et l'une
   * dangereuse, vivent derrière la fiche.
   */
  export let roomDisabled = false;
  /**
   * La réponse reçue à une offre pour CE jeu, ou null.
   *
   * `'already-here'` quand l'ami a déjà le jeu, `'unreachable'` quand personne
   * n'était joignable, `null` pour un vrai « non merci ». Affichée parce que
   * c'est la seule chose qui explique un écran resté vide chez l'autre, et
   * que celui qui a besoin de l'explication est celui qui attend : le
   * 2026-09-10, elle existait et n'arrivait nulle part.
   */
  export let shareAnswer: string | null | undefined = undefined;

  $: answerKey = ((): TranslationKey | null => {
    if (shareAnswer === undefined) return null;
    if (shareAnswer === 'already-here') return 'shareAlreadyHas';
    if (shareAnswer === 'unreachable') return 'shareUnreachable';
    return 'shareRefused';
  })();

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

  /**
   * L'avertissement sur la licence, lu une fois avant le premier envoi.
   *
   * L'accord vit dans le stockage de l'appareil - voir `share-consent.ts` pour
   * pourquoi il n'est pas en base - et n'est lu qu'au clic : à la construction
   * du composant, le rendu serveur n'a pas de `localStorage`, et un accès
   * gardé par un `try` à cet endroit ne dirait rien de plus.
   */
  let askingConsent = false;

  /** Le stockage de l'appareil, ou rien quand il est refusé ou absent. */
  function consentStorage(): PreferenceStorage | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      // Navigation privée, cookies tiers bloqués : l'accord ne peut pas être
      // retenu. L'avertissement est alors reposé à chaque envoi, ce qui est le
      // bon sens de l'échec - jamais l'inverse.
      return null;
    }
  }

  function requestShare() {
    const storage = consentStorage();
    if (storage && hasShareConsent(storage)) {
      dispatch('share');
      return;
    }
    askingConsent = true;
  }

  function confirmShare() {
    const storage = consentStorage();
    if (storage) grantShareConsent(storage);
    askingConsent = false;
    dispatch('share');
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

    <!--
      Deux étages : le corps défile, la barre d'actions non. Les boutons
      fermaient la fiche, sous la jaquette, la description et les
      métadonnées, si bien qu'en 360x640 il fallait défiler plus d'un écran
      pour atteindre Salon.
    -->
    <div class="modal-body">
      <div class="modal-grid">
        <div class="cover-section">
          {#if game.coverUrl}
            <!--
              Sans `width` ni `height` : ils valaient 512x358, le format d'une
              boîte américaine, et comme aucune règle ne rendait sa hauteur au
              navigateur, une boîte européenne ou japonaise était écrasée dans ce
              cadre. Le format n'est connu qu'au chargement - le serveur ramène
              chaque jaquette à 512 de large et garde sa hauteur - donc rien à
              réserver d'avance : l'image prend le sien, dans les bornes du CSS.
            -->
            <img
              src={game.coverUrl}
              alt={game.title}
              class="cover-image"
              decoding="async"
            />
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
        </div>
      </div>
    </div>

    <!--
      Toutes les actions de la fiche, et le partage avec elles : c'est la
      barre que la fiche ouverte montre sans défiler, quelle que soit la
      hauteur de la fenêtre. Reprendre une partie reste dans le corps - la
      grille des sauvegardes est un contenu à parcourir, pas un bouton.
    -->
    <footer class="actions">
      {#if game.crc32 && partnerName}
        <!--
          Envoyer le jeu à l'ami du groupe.

          Ici plutôt que sur la carte : la carte porte déjà Jouer, Salon et
          Supprimer, et ceci est une action rare - c'est là que vivent les
          autres. Le partage n'était jusqu'ici qu'un effet de bord du
          lancement, déclenché par l'absence de fichier chez l'invité au
          pire moment ; ce bouton est le geste délibéré qui le remplace.
        -->
        {#if askingConsent}
          <!--
            L'avertissement remplace le bouton au lieu de s'ouvrir par-dessus.
            Une modale au-dessus d'une modale, pour une phrase et deux
            boutons, c'est un écran de plus à fermer ; et l'avertissement doit
            se lire là où le geste part, pas ailleurs.
          -->
          <div class="share-consent">
            <p class="share-consent-text">{t($language, 'shareLegal')}</p>
            <div class="share-consent-actions">
              <button class="share" on:click={confirmShare}>
                {t($language, 'shareLegalConfirm')}
              </button>
              <button class="share-consent-cancel" on:click={() => (askingConsent = false)}>
                {t($language, 'cancel')}
              </button>
            </div>
          </div>
        {:else}
          <!--
            Le bouton et son rappel dans un même bloc : posés côte à côte
            dans le flux, la phrase prenait toute la largeur sous la rangée
            et se lisait comme une note sur « Compléter la fiche » autant que
            sur l'envoi.
          -->
          <div class="share-block">
            <button class="share" on:click={requestShare} disabled={sharePending}>
              {sharePending
                ? t($language, 'shareWaiting', { name: partnerName })
                : t($language, 'shareGame', { name: partnerName })}
            </button>
            <!--
              Le rappel court reste, alors que l'avertissement complet ne se
              lit qu'une fois. C'est ce qui rattrape ce que l'accord unique
              laisse passer : la licence dépend de CHAQUE jeu envoyé, et
              personne ne relit une question qui ne revient plus.
            -->
            <p class="share-legal-short">{t($language, 'shareLegalShort')}</p>
            {#if answerKey && !sharePending}
              <p class="share-answer">
                {t($language, answerKey, { name: partnerName })}
              </p>
            {/if}
          </div>
        {/if}
      {/if}

      <!-- Salon d'abord : c'est l'action que la fiche sert le plus, et la
           première que le pouce trouve. -->
      <div class="secondary">
        <button class="room" on:click={() => dispatch('room')} disabled={roomDisabled}>
          {t($language, 'roomButton')}
        </button>

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
        {/if}

        <!-- Une icône, plus un libellé porté par aria-label : le nom
             accessible ne doit pas disparaître avec le mot. SVG et non
             emoji, pour qu'un contrôle ne puisse pas s'afficher en carré
             vide selon la police du système. -->
        <button
          class="delete"
          on:click={() => dispatch('delete')}
          aria-label={t($language, 'delete')}
          title={t($language, 'delete')}
        >
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor"
               stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
            <path d="M2.5 4.5h11M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5" />
            <path d="M4 4.5l.7 8.2a.8.8 0 0 0 .8.8h5a.8.8 0 0 0 .8-.8l.7-8.2" />
            <path d="M6.8 7v4M9.2 7v4" />
          </svg>
        </button>
      </div>
      {#if exportError}<p class="export-error">{exportError}</p>{/if}
    </footer>
  </div>
</div>

<style>
  .secondary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  /* 44 px de haut, la cible d'un pouce : à 0.45rem de marge intérieure ces
     boutons en faisaient une trentaine, et ce sont eux qu'on vise en premier
     sur un téléphone maintenant qu'ils restent à l'écran. */
  .room,
  .delete,
  .identify,
  .share,
  .export-saves,
  .share-consent-cancel {
    min-height: 44px;
  }

  .room,
  .delete {
    background: transparent;
    border: 1px solid #3d3d52;
    color: #b7b7cc;
    border-radius: 6px;
    padding: 0.45rem 1rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .delete {
    display: grid;
    place-items: center;
    min-width: 44px;
    padding: 0.45rem 0.6rem;
    margin-left: auto;
  }

  /* L'or du HUD, et non le violet : c'est la couleur qui dit « ceci
     répond » partout ailleurs dans cette interface depuis la reprise. */
  .room:hover:not(:disabled) {
    border-color: var(--edge);
    color: var(--label);
  }

  /* La seule action irréversible de cet écran : elle ne se colore qu'au
     moment où le curseur la vise, pour ne pas réclamer l'attention au
     repos. */
  .delete:hover {
    border-color: #b3403f;
    color: #ff9a99;
  }

  .room:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .share-answer {
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: #9a9ab0;
  }

  .share:disabled {
    opacity: 0.6;
    cursor: default;
  }

  /* Peint comme ses voisins de la même colonne. Il ne portait que sa marge
     et sa largeur, donc le bouton brut du navigateur juste sous deux boutons
     habillés - la même omission que `.share` plus tôt dans la journée. */
  .export-saves {
    background: transparent;
    border: 1px solid #3d3d52;
    color: #b7b7cc;
    border-radius: 6px;
    padding: 0.45rem 1rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .export-saves:hover:not(:disabled) {
    border-color: var(--edge);
    color: var(--label);
  }

  .export-saves:disabled {
    opacity: 0.6;
    cursor: default;
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

  /* `.share` rend le même bouton que `.identify` : ce sont deux actions de
     même poids au même endroit, et le rendu a montré ce qu'aucun test ne
     voyait - `.share` sans règle prenait le bouton brut du navigateur, blanc
     et carré, à côté de son voisin. */
  .identify,
  .share {
    background: transparent;
    border: 1px solid #3d3d52;
    color: #b7b7cc;
    border-radius: 6px;
    padding: 0.45rem 1rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .identify:hover,
  .share:hover:not(:disabled) {
    border-color: var(--edge);
    color: var(--label);
  }

  /* Sa propre rangée, au-dessus des boutons : la phrase qui l'accompagne ne
     tient pas dans une rangée qui passe à la ligne sur un téléphone, et elle
     doit rester collée à l'envoi, pas à ses voisins. */
  .share-block {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }

  /* Le rappel court porte la couleur des réponses de partage juste au-dessus :
     c'est la même voix - ce que la machine dit à côté du bouton - et deux gris
     différents pour deux lignes voisines se lisent comme une hiérarchie qui
     n'existe pas. */
  .share-legal-short {
    margin: 0.4rem 0 0;
    font-size: 0.75rem;
    color: #8b8ba3;
  }

  .share-consent {
    padding: 0.75rem 0.9rem;
    border: 1px solid #3d3d52;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.2);
  }

  .share-consent-text {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.5;
    color: #b7b7cc;
  }

  .share-consent-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  /* Les deux boutons du cadre se décollent du texte au-dessus d'eux. */
  .share-consent-actions .share {
    margin-top: 0.75rem;
  }

  .share-consent-cancel {
    margin-top: 0.75rem;
    align-self: flex-start;
    background: transparent;
    border: 1px solid transparent;
    color: #8b8ba3;
    border-radius: 6px;
    padding: 0.45rem 0.75rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .share-consent-cancel:hover {
    color: var(--label);
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
    /* La fiche tient dans ce cadre, et le cadre dans la fenêtre : un
       élément fixe tendu de bord à bord suit la hauteur réelle de l'écran,
       barre d'adresse mobile comprise - le 100dvh que 90vh n'était pas. Les
       encoches et la barre de geste s'ajoutent à la marge au lieu de la
       manger. */
    padding: max(2rem, env(safe-area-inset-top)) max(2rem, env(safe-area-inset-right))
      max(2rem, env(safe-area-inset-bottom)) max(2rem, env(safe-area-inset-left));
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
    max-height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
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

  /* Le corps prend ce que la barre d'actions laisse, et défile seul.
      `min-height: 0` est ce qui l'autorise à rétrécir sous la hauteur de son
     contenu : sans lui, un enfant flex refuse, et la barre sort du cadre. */
  .modal-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .actions {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem 2.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    background: #262626;
  }

  .close-btn {
    position: absolute;
    top: 1.5rem;
    right: 1.5rem;
    width: 44px;
    height: 44px;
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

  /* Chaque jaquette à son propre format, dans une boîte bornée : une boîte
     américaine est plus large que haute, une européenne ou japonaise plus
     haute que large, et les images récupérées ailleurs varient encore.
     `auto` sur les deux côtés et des bornes en `max-` : la boîte suit
     l'image, sans l'étirer ni la rogner, et le cadre arrondi épouse
     l'image plutôt qu'une bande vide autour. */
  .cover-image {
    display: block;
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 60vh;
    margin: 0 auto;
    object-fit: contain;
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

  /* Plus de dégradé sur un mot : c'est le tell générique par excellence,
     et il dépensait le seul accent de cette fiche sur son titre plutôt que
     sur la jaquette qu'on vient regarder. La police d'affichage le rattache
     au reste. */
  .title {
    font-size: 2rem;
    margin: 0 0 1.5rem 0;
    font-family: var(--display);
    font-weight: 700;
    line-height: 1.2;
    color: var(--label);
  }

  .description {
    font-size: 1.125rem;
    line-height: 1.7;
    color: #ccc;
    margin: 0 0 2rem 0;
    padding: 1.5rem;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 12px;
    border-left: 3px solid var(--edge);
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
    .modal-overlay {
      padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right))
        max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left));
    }

    .modal-content {
      border-radius: 16px;
    }

    /* Le haut dégagé pour le bouton de fermeture : une boîte américaine
       prend toute la largeur, et la croix se posait sur son coin. */
    .modal-grid {
      grid-template-columns: 1fr;
      gap: 1.5rem;
      padding: calc(0.75rem + 44px + 0.5rem) 1.25rem 1.25rem;
    }

    /* Salon, Compléter la fiche et la corbeille sur une seule rangée en
       360 de large : avec les marges du bureau, la corbeille passait seule
       à la ligne et la barre prenait 50 px de plus sur l'écran. */
    .actions {
      padding: 0.75rem 1rem;
    }

    .room,
    .identify,
    .share,
    .export-saves {
      padding-left: 0.75rem;
      padding-right: 0.75rem;
    }

    .close-btn {
      top: 0.75rem;
      right: 0.75rem;
    }

    .cover-section {
      position: static;
    }

    .cover-image,
    .cover-placeholder {
      max-width: min(100%, 320px);
      margin: 0 auto;
    }

    /* Assez de jaquette pour la reconnaître, et le titre juste dessous
       dès l'ouverture. */
    .cover-image {
      max-height: 40vh;
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
  .modal-body::-webkit-scrollbar {
    width: 8px;
  }

  .modal-body::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
  }

  .modal-body::-webkit-scrollbar-thumb {
    background: rgba(248, 208, 48, 0.45);
    border-radius: 4px;
  }

  .modal-body::-webkit-scrollbar-thumb:hover {
    background: rgba(248, 208, 48, 0.75);
  }
</style>
