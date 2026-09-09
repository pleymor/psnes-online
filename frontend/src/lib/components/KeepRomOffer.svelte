<script lang="ts">
  /**
   * « Garder ce jeu sur cet appareil ? », posé à l'invité qui vient de le
   * recevoir de l'hôte.
   *
   * Non modal, et c'est le point : `keep-offer.ts` explique pourquoi la
   * question arrive après le transfert plutôt qu'avant. La partie tourne
   * derrière, les deux joueurs jouent, et une réponse peut attendre - donc pas
   * de fond opaque, pas de piège au clavier, rien qui réclame le geste avant
   * de rendre la manette.
   *
   * Partagé par `LockstepRoom` et `P2PRoom` : deux salons plats, une seule
   * question, et un seul endroit où corriger les mots.
   */
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import type { KeepOffer } from '$lib/roms/keep-offer';

  export let offer: KeepOffer;
  export let title = '';

  const asked = offer.asked;
</script>

{#if $asked}
  <section class="keep-rom" aria-label={t($language, 'keepRom')}>
    <div class="keep-rom-text">
      <p class="keep-rom-question">
        {title ? `${title} — ` : ''}{t($language, 'keepRom')}
      </p>
      <p class="keep-rom-legal">{t($language, 'keepRomLegal')}</p>
    </div>
    <div class="keep-rom-actions">
      <button type="button" class="keep" on:click={() => offer.accept()}>
        {t($language, 'keepRomYes')}
      </button>
      <button type="button" class="decline" on:click={() => offer.decline()}>
        {t($language, 'keepRomNo')}
      </button>
    </div>
  </section>
{/if}

<style>
  /* Le bandeau de transfert a fini quand la question arrive : sa place au bas
     de l'écran est libre, et c'est là que le joueur regardait. */
  .keep-rom {
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

  .keep-rom-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 12rem;
    flex: 1;
  }

  .keep-rom-question {
    margin: 0;
  }

  .keep-rom-legal {
    margin: 0;
    color: #8b8ba3;
    font-size: 0.78rem;
  }

  .keep-rom-actions {
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

  button.keep {
    background: #2f6f4f;
    border-color: #3c8c64;
  }

  button:hover {
    filter: brightness(1.15);
  }

  button:focus-visible {
    outline: 2px solid #6f8bff;
    outline-offset: 2px;
  }
</style>
