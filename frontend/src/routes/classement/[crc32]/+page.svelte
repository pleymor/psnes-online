<script lang="ts">
  import { onMount } from 'svelte';
  import { language, type Language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import TopBar from '$lib/components/TopBar.svelte';
  import { formatHandle } from '$lib/pseudo';
  import {
    fetchRanking, fetchMatches,
    type RankedPlayer, type PlayedRow, type RatingsFailure
  } from '$lib/api/ratings';

  export let data: { crc32: string };

  /*
   * Trois états, pas deux. « Pas encore chargé », « chargé et vide » et
   * « n'a pas pu être chargé » se dessinent différemment : confondre les deux
   * derniers ferait lire un hoquet réseau comme « personne n'a jamais joué »,
   * ce que l'union discriminée de `api/ratings.ts` existe pour empêcher.
   */
  let players: RankedPlayer[] | null = null;
  let matches: PlayedRow[] | null = null;

  /*
   * Deux échecs distincts, et pas une variable `failure` commune : les deux
   * requêtes sont indépendantes, et fusionner leurs échecs affichait le
   * message d'une section au-dessus de l'autre, correctement rendue - « le
   * classement n'a pas pu être chargé » planté au-dessus d'un classement bien
   * là. Chacun s'affiche dans sa propre section, avec son propre message.
   */
  let rankingFailure: RatingsFailure | null = null;
  let matchesFailure: RatingsFailure | null = null;

  onMount(async () => {
    const [ranking, history] = await Promise.all([
      fetchRanking(data.crc32),
      fetchMatches(data.crc32)
    ]);
    if (!ranking.ok) rankingFailure = ranking.reason;
    else players = ranking.players;
    if (!history.ok) matchesFailure = history.reason;
    else matches = history.matches;
  });

  /*
   * `$language` en paramètre plutôt que lu dans le corps de ces fonctions :
   * le crible Svelte 4 (voir RoomPlayers.svelte) ne marque une ligne du
   * `{#each}` sale que pour les identifiants écrits littéralement dans le
   * gabarit - jamais pour ce qu'une fonction appelée depuis ce gabarit lit
   * elle-même. `$language` ne figurait dans le texte d'aucune instruction de
   * l'historique, donc aucune garde compilée ne le portait : changer de
   * langue rafraîchissait le titre et le classement (où `{t($language, …)}`
   * est écrit en clair dans le gabarit) et laissait l'historique dans
   * l'ancienne langue.
   */

  /** Le vainqueur d'une ligne, dit avec son handle complet plutôt qu'un numéro de port. */
  /**
   * Le vainqueur, dit comme une phrase et non comme un troisième nom.
   *
   * « Pleymor#2147 — fredoche#6055 / fredoche#6055 » se devine ; « gagné par »
   * se lit. Le double KO garde son propre mot : il n'a personne à nommer, et
   * l'habiller en « gagné par » demanderait un nom qui n'existe pas.
   */
  function winnerOf(row: PlayedRow, lang: Language): string {
    if (row.winner === 0) return t(lang, 'drawnLabel');
    const side = row.winner === 1 ? row.p1 : row.p2;
    const name = side
      ? formatHandle(side.pseudo, side.discriminator)
      : t(lang, 'unknownHistoryPlayer');
    return t(lang, 'wonBy', { name });
  }

  /**
   * Un joueur d'une ligne, ou le mot qui remplace son absence.
   *
   * `unknownHistoryPlayer` et non `guestPlayer` : un côté NULL de l'historique
   * est soit un invité (présent, réellement anonyme), soit un compte supprimé
   * (qui n'est plus personne) - les deux valent NULL et rien ne les distingue
   * ici. Le paragraphe RGPD promet que la ligne d'un compte supprimé survit
   * comme « la trace d'une partie que votre adversaire a jouée », pas comme un
   * invité. `guestPlayer` reste réservé au salon, où le joueur est bien
   * présent et bien anonyme.
   */
  function nameOf(side: PlayedRow['p1'], lang: Language): string {
    return side ? formatHandle(side.pseudo, side.discriminator) : t(lang, 'unknownHistoryPlayer');
  }

  function when(at: number, lang: Language): string {
    return new Date(at).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' });
  }

  /** `ratingWithMatches` fait toujours le pluriel ; ce cas est le premier du
   * classement à une seule partie, mis en avant par la conception. */
  function matchesKey(matchCount: number): 'ratingWithOneMatch' | 'ratingWithMatches' {
    return matchCount === 1 ? 'ratingWithOneMatch' : 'ratingWithMatches';
  }
</script>

<TopBar />

<main class="classement">
  <h1>{t($language, 'ranking')}</h1>

  {#if rankingFailure}
    <!-- `ratingsSessionExpired` et non `sessionExpired` : celle-ci parle des
         sauvegardes, et afficherait un message faux sur cet écran. -->
    <p class="failure">
      {t($language, rankingFailure === 'sessionExpired' ? 'ratingsSessionExpired' : 'failedToLoadRatings')}
    </p>
  {/if}

  {#if players}
    {#if players.length === 0}
      <p class="muted">{t($language, 'noMatchesYet')}</p>
    {:else}
      <ol class="ranking">
        {#each players as player, i}
          <li>
            <span class="rank">{i + 1}</span>
            {#if player.avatar}<img src={player.avatar} alt="" class="avatar" />{/if}
            <span class="name">{formatHandle(player.pseudo, player.discriminator)}</span>
            <!-- `matches` à côté de la cote, et pas en petit : sans seuil
                 d'entrée, un joueur à une victoire est en tête, et c'est ce
                 nombre qui permet de le lire comme tel. -->
            <span class="rating">
              {t($language, matchesKey(player.matches), { rating: player.rating, matches: player.matches })}
            </span>
          </li>
        {/each}
      </ol>
    {/if}
  {/if}

  <h2>{t($language, 'matchHistory')}</h2>

  {#if matchesFailure}
    <p class="failure">
      {t($language, matchesFailure === 'sessionExpired' ? 'matchHistorySessionExpired' : 'failedToLoadMatchHistory')}
    </p>
  {/if}

  {#if matches}
    {#if matches.length === 0}
      <p class="muted">{t($language, 'noMatchesYet')}</p>
    {:else}
      <ul class="matches">
        {#each matches as row}
          <li>
            <span class="when">{when(row.playedAt, $language)}</span>
            <span class="who">{nameOf(row.p1, $language)} — {nameOf(row.p2, $language)}</span>
            <span class="winner">{winnerOf(row, $language)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</main>

<style>
  /* La même enveloppe que /profile et /docs : une colonne bornée, centrée. */
  .classement {
    width: 100%;
    max-width: 60rem;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 4rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  h1 {
    margin: 0;
    font-family: 'Silkscreen', monospace;
    font-size: 1.6rem;
    font-weight: 400;
    line-height: 1.4;
    color: var(--label);
  }

  h2 {
    margin: 0.5rem 0 0;
    font-size: 1.2rem;
    color: var(--label);
  }

  .failure {
    color: #ff8a8a;
  }

  /* Pas classé, ou personne n'a encore joué : une information plutôt qu'un
     résultat - la même classe que RoomPlayers. */
  .muted {
    color: #9aa0b4;
  }

  .ranking,
  .matches {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .ranking li,
  .matches li {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: var(--panel);
    border-radius: 10px;
    padding: 0.6rem 0.9rem;
  }

  .rank {
    font-weight: 600;
    color: var(--edge);
    min-width: 1.5rem;
  }

  .avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
  }

  .name {
    flex: 1;
    font-weight: 600;
  }

  .rating {
    color: var(--label);
  }

  .matches li {
    flex-wrap: wrap;
    font-size: 0.9rem;
  }

  .when {
    color: #9aa0b4;
    min-width: 9rem;
  }

  .who {
    flex: 1;
  }

  .winner {
    color: var(--label);
    font-weight: 600;
  }
</style>
