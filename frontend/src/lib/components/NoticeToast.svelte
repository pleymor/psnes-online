<script lang="ts">
  /**
   * Ce qui passe à l'écran, et qui remplace `NotificationToast`.
   *
   * Une seule pile, en haut à droite, où six surfaces se tenaient. Un toast
   * porte maintenant des boutons quand son `kind` en a : c'est ce qui permet
   * de répondre à une invitation en un clic, comme la carte épinglée le
   * permettait, sans garder la carte épinglée.
   */
  import { onMount, onDestroy } from 'svelte';
  import { fly } from 'svelte/transition';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { inGame } from '$lib/stores/in-game';
  import { notices, inGameSurfaces, actionsInFlight } from '$lib/services/notification';
  import { shapeOf, isOnScreen, toneOf } from '$lib/notices/shapes';
  import { actionsOf } from '$lib/notices/actions';
  import type { Notice } from '$lib/notices/notice';

  /**
   * Quelle moitié des notifications cette instance peint.
   *
   * `page` est celle du layout : tout ce qui s'affiche hors partie.
   * `in-game` est celle qu'un salon monte DANS son élément plein écran, pour
   * les seules notifications qui se répondent pendant une partie. L'API
   * Fullscreen ne peint que l'élément passé en plein écran et ses
   * descendants : une notification rendue ailleurs dans le document n'existe
   * plus à l'écran, et « garder ce jeu ? » est justement posée là.
   *
   * Les deux moitiés sont disjointes, donc rien ne s'affiche deux fois.
   */
  export let surface: 'page' | 'in-game' = 'page';

  const list = notices.list;

  let now = Date.now();
  let clock: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    clock = setInterval(() => (now = Date.now()), 500);
    // Compté à onMount et décompté à onDestroy : c'est ce qui permet à la
    // moitié `page` de savoir si une moitié `in-game` est là pour prendre le
    // relais, sans qu'aucune des deux ne connaisse l'autre par son nom.
    if (surface === 'in-game') inGameSurfaces.update((n) => n + 1);
  });

  onDestroy(() => {
    clearInterval(clock);
    if (surface === 'in-game') inGameSurfaces.update((n) => n - 1);
  });

  /**
   * Ce qui a le droit d'être à l'écran en ce moment.
   *
   * Le compte à rebours part de `at`, la naissance de la notification, et non
   * du moment où ce composant l'a vue. C'est ce qui fait qu'une notification
   * revenue du stockage ne resurgit pas à l'écran au rechargement : son `at`
   * est déjà loin, elle est donc directement dans le centre - ce qu'on veut
   * d'un rattrapage.
   *
   * Rien pendant une partie, sauf ce qui porte `duringGame` : un panneau
   * au-dessus d'un émulateur vole un clic, et accepter une invitation ferait
   * sortir le joueur de son match. La notification n'est pas perdue pour
   * autant - elle est dans le centre, et la pastille le dit.
   *
   * `now` et `$list` sont nommés DANS l'expression réactive, jamais seulement
   * lus au fond d'une fonction : en Svelte 4, une dépendance cachée dans un
   * corps de fonction ne redéclenche rien, et ce fichier a besoin de battre.
   */
  $: shown = $list.filter((notice: Notice) => {
    const shape = shapeOf(notice.kind);
    if (!shape) return false;

    if (surface === 'in-game') {
      if (!$inGame || shape.duringGame !== true) return false;
    } else if ($inGame) {
      // Repli : sans surface dédiée montée, c'est mieux que rien.
      if (shape.duringGame !== true || $inGameSurfaces > 0) return false;
    }

    return isOnScreen(notice, now);
  });

  /**
   * Les actions en vol, pour que deux clics n'envoient pas deux réponses.
   *
   * Partagé avec `NoticeCentre` par `actionsInFlight` : hors partie, une
   * notification à boutons peut être visible dans les deux à la fois, et un
   * clic sur l'une pendant que l'autre est en vol enverrait deux réponses si
   * chacune gardait son propre `Set`.
   */
  const running = actionsInFlight;

  async function act(notice: Notice, index: number) {
    if ($running.has(notice.id)) return;
    running.update((s) => new Set(s).add(notice.id));

    try {
      await actionsOf(notice.kind)[index]?.run(notice.params);
      // Retirée seulement une fois l'action passée. L'inverse - retirer
      // d'abord - faisait disparaître la notification du centre avant de
      // savoir si le geste avait abouti : un réseau qui tombe laissait la
      // question sans bouton et sans trace.
      notices.dismiss(notice.id);
    } catch {
      // L'action a échoué : la notification reste, avec ses boutons, et
      // peut être retentée.
    } finally {
      running.update((s) => {
        const next = new Set(s);
        next.delete(notice.id);
        return next;
      });
    }
  }
</script>

{#if shown.length > 0}
  <div class="toasts">
    {#each shown as notice (notice.id)}
      {@const shape = shapeOf(notice.kind)}
      {@const actions = actionsOf(notice.kind)}
      <div class="toast toast-{toneOf(notice)}" role="alert" transition:fly={{ y: -20, duration: 300 }}>
        <div class="toast-text">
          <span class="toast-message">{shape?.text(notice.params, $language) ?? ''}</span>
          {#if shape?.legal}
            <span class="toast-legal">{t($language, shape.legal)}</span>
          {/if}
        </div>
        {#if actions.length > 0}
          <div class="toast-actions">
            {#each actions as action, index}
              <button
                class:primary={action.primary}
                disabled={$running.has(notice.id)}
                on:click={() => act(notice, index)}
              >
                {t($language, action.label)}
              </button>
            {/each}
          </div>
        {:else}
          <button class="close" aria-label={t($language, 'close')} on:click={() => notices.dismiss(notice.id)}>
            ×
          </button>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .toasts {
    position: fixed;
    /* Sous la barre du haut, et non à 20px du haut de la fenêtre : la barre
       est sticky à z-index 101 mais mesure environ 57px (un bouton de 38px,
       0,5rem de marge intérieure de chaque côté, un liseré de 3px), et un
       toast fixé plus haut passe par-dessus elle - juste sur la cloche, à
       droite, qui devient inatteignable au moment où on aurait une raison
       de l'ouvrir. Sur un écran sans barre, un toast un peu plus bas ne
       gêne personne ; un toast qui mange la cloche, si. */
    top: 4.5rem;
    right: 20px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: min(26rem, calc(100vw - 2rem));
  }

  .toast {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    background: rgba(20, 20, 30, 0.92);
    border: 1px solid #2c2c3c;
    color: #e6e6f0;
    font-size: 0.85rem;
  }

  .toast-text {
    flex: 1;
    min-width: 10rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  /* Le ton discret que `ShareOffer` et `KeepRomOffer` portaient déjà pour
     cette même ligne. */
  .toast-legal {
    color: #8b8ba3;
    font-size: 0.78rem;
  }

  .toast-actions {
    display: flex;
    gap: 0.5rem;
  }

  .toast-info { border-left: 3px solid #6f8bff; }
  .toast-success { border-left: 3px solid #3c8c64; }
  .toast-error { border-left: 3px solid #b8455a; }
  .toast-warning { border-left: 3px solid #b8934a; }

  button {
    padding: 0.35rem 0.8rem;
    border-radius: 999px;
    border: 1px solid #2c2c3c;
    background: #1b1b28;
    color: #e6e6f0;
    font-size: 0.8rem;
    cursor: pointer;
  }

  button.primary {
    background: #2f6f4f;
    border-color: #3c8c64;
  }

  button:hover { filter: brightness(1.15); }

  button:focus-visible {
    outline: 2px solid #6f8bff;
    outline-offset: 2px;
  }

  .close {
    border: none;
    background: transparent;
    padding: 0 0.25rem;
    font-size: 1.25rem;
    line-height: 1;
  }
</style>
