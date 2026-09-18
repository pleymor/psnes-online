<script lang="ts">
  import { onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import TopBar from '$lib/components/TopBar.svelte';
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
  let failure: RatingsFailure | null = null;

  onMount(async () => {
    const [ranking, history] = await Promise.all([
      fetchRanking(data.crc32),
      fetchMatches(data.crc32)
    ]);
    if (!ranking.ok) failure = ranking.reason;
    else players = ranking.players;
    if (!history.ok) failure ??= history.reason;
    else matches = history.matches;
  });

  /** Le vainqueur d'une ligne, dit avec un nom plutôt qu'un numéro de port. */
  function winnerOf(row: PlayedRow): string {
    if (row.winner === 0) return t($language, 'matchDrawn');
    const side = row.winner === 1 ? row.p1 : row.p2;
    return side ? side.pseudo : t($language, 'guestPlayer');
  }

  /** Un joueur d'une ligne, ou le mot qui remplace son absence. */
  function nameOf(side: PlayedRow['p1']): string {
    return side ? `${side.pseudo}#${side.discriminator}` : t($language, 'guestPlayer');
  }

  function when(at: number): string {
    return new Date(at).toLocaleString($language, { dateStyle: 'short', timeStyle: 'short' });
  }
</script>

<TopBar />

<main class="classement">
  <h1>{t($language, 'ranking')}</h1>

  {#if failure}
    <!-- `ratingsSessionExpired` et non `sessionExpired` : celle-ci parle des
         sauvegardes, et afficherait un message faux sur cet écran. -->
    <p class="failure">
      {t($language, failure === 'sessionExpired' ? 'ratingsSessionExpired' : 'failedToLoadRatings')}
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
            <span class="name">{player.pseudo}#{player.discriminator}</span>
            <!-- `matches` à côté de la cote, et pas en petit : sans seuil
                 d'entrée, un joueur à une victoire est en tête, et c'est ce
                 nombre qui permet de le lire comme tel. -->
            <span class="rating">
              {t($language, 'ratingWithMatches', { rating: player.rating, matches: player.matches })}
            </span>
          </li>
        {/each}
      </ol>
    {/if}
  {/if}

  <h2>{t($language, 'matchHistory')}</h2>

  {#if matches}
    {#if matches.length === 0}
      <p class="muted">{t($language, 'noMatchesYet')}</p>
    {:else}
      <ul class="matches">
        {#each matches as row}
          <li>
            <span class="when">{when(row.playedAt)}</span>
            <span class="who">{nameOf(row.p1)} — {nameOf(row.p2)}</span>
            <span class="winner">{winnerOf(row)}</span>
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
