<script lang="ts">
  /**
   * « Untel veut t'envoyer Donkey Kong Country », posé à l'ami du groupe.
   *
   * Le pendant de `KeepRomOffer`, à l'autre bout du même geste et au moment
   * inverse : celle-là arrive APRÈS le transfert, parce qu'une partie tourne
   * et que faire attendre deux joueurs pour la question d'un seul appareil
   * était exactement ce qu'il fallait éviter. Ici personne ne joue, donc le
   * moment gratuit est avant - et demander avant évite de pousser quatre
   * mégaoctets vers quelqu'un qui va refuser.
   *
   * Dans le layout et pas dans la bibliothèque, pour la raison qu'
   * `InvitationCard` donne pour elle-même : une offre doit atteindre le
   * joueur là où il est, pas là où l'expéditeur l'imagine.
   */
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { Sharing } from '$lib/roms/sharing';

  export let sharing: Sharing;
  /** Le pseudo de l'ami, que le salon connaît et que le relais ne dit pas. */
  export let fromName = '';

  const offered = sharing.offered;
</script>

{#if $offered}
  <section class="share-offer" aria-label={t($language, 'shareAccept')}>
    <div class="share-offer-text">
      <p class="share-offer-question">
        {t($language, 'shareOffer', { name: fromName, title: $offered.title })}
      </p>
      <!-- La même phrase qu'au moment de garder, et pour la même raison : on
           ne garde un jeu que si l'on possède la cartouche. Ici elle arrive
           avant l'envoi, donc au moment où elle peut encore changer la
           réponse. -->
      <p class="share-offer-legal">{t($language, 'keepRomLegal')}</p>
    </div>
    <div class="share-offer-actions">
      <button type="button" class="accept" on:click={() => sharing.accept()}>
        {t($language, 'shareAccept')}
      </button>
      <button type="button" class="decline" on:click={() => sharing.decline()}>
        {t($language, 'keepRomNo')}
      </button>
    </div>
  </section>
{/if}

<style>
  /* La place et la forme de `KeepRomOffer` : c'est la même conversation, et
     deux cartes différentes pour un même sujet se liraient comme deux
     sujets. */
  .share-offer {
    position: fixed;
    left: 50%;
    bottom: 2rem;
    transform: translateX(-50%);
    z-index: 900;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1.25rem;
    max-width: min(38rem, calc(100vw - 2rem));
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    background: rgba(20, 20, 30, 0.92);
    border: 1px solid #2c2c3c;
    color: #e6e6f0;
    font-size: 0.85rem;
  }

  .share-offer-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 12rem;
    flex: 1;
  }

  .share-offer-question {
    margin: 0;
  }

  .share-offer-legal {
    margin: 0;
    color: #8b8ba3;
    font-size: 0.78rem;
  }

  .share-offer-actions {
    display: flex;
    gap: 0.5rem;
  }

  button {
    padding: 0.4rem 0.85rem;
    border-radius: 999px;
    border: 1px solid #2c2c3c;
    background: #1b1b28;
    color: #e6e6f0;
    font-size: 0.82rem;
    cursor: pointer;
  }

  button.accept {
    background: #2f6f4f;
    border-color: #3c8c64;
  }
</style>
