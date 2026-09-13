<script lang="ts">
  /**
   * La cloche et ce qu'elle ouvre.
   *
   * Dans la barre du haut, donc absente de l'accueil déconnecté et d'une
   * partie en plein écran - c'est pourquoi `keep-rom` ne compte pas sur elle
   * et garde un toast qui ne s'efface pas.
   *
   * Le vidage a lieu à la FERMETURE : vidé à l'ouverture, le centre
   * s'effacerait sous les yeux de qui vient le lire. Ce qui arrive pendant la
   * lecture s'y ajoute, visiblement, et part avec le reste.
   */
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { notices } from '$lib/services/notification';
  import { shapeOf } from '$lib/notices/shapes';
  import { actionsOf } from '$lib/notices/actions';
  import type { Notice } from '$lib/notices/notice';

  const list = notices.list;
  const open = notices.open;
  const count = notices.count;

  function toggle() {
    if ($open) notices.closeCentre();
    else notices.openCentre();
  }

  /**
   * Les actions en vol, pour que deux clics n'envoient pas deux réponses.
   *
   * Un `Set` réassigné et non muté : en Svelte 4, muter un `Set` ne
   * redéclenche rien, et c'est l'état désactivé des boutons qui en dépend.
   * Même garde que `NoticeToast` - la table est vide avant la tâche 7, mais
   * le panneau doit se comporter pareil dès qu'un `kind` en portera.
   */
  let running = new Set<string>();

  async function act(notice: Notice, index: number) {
    if (running.has(notice.id)) return;
    running = new Set(running).add(notice.id);

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
      running = new Set([...running].filter((id) => id !== notice.id));
    }
  }
</script>

<!-- La cloche reste quand il n'y a rien : un élément de barre qui apparaît et
     disparaît fait sauter la mise en page, et une cloche muette dit « rien de
     nouveau », ce qui est une information. -->
<div class="bell-wrap">
  <button
    class="bell"
    aria-label={t($language, 'notices')}
    aria-expanded={$open}
    on:click={toggle}
  >
    <!-- SVG et non emoji : un caractère de cloche s'affiche en carré vide
         selon la police du système, comme la corbeille de la fiche du jeu. -->
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M12 3a5 5 0 0 0-5 5v3.6L5.5 14.5h13L17 11.6V8a5 5 0 0 0-5-5Zm0 18a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 21Z"
        fill="currentColor"
      />
    </svg>
    {#if $count > 0}
      <span class="badge">{$count}</span>
    {/if}
  </button>

  {#if $open}
    <div class="panel" role="dialog" aria-label={t($language, 'notices')}>
      {#if $list.length === 0}
        <p class="empty">{t($language, 'noticesEmpty')}</p>
      {:else}
        <ul>
          {#each $list as notice (notice.id)}
            {@const shape = shapeOf(notice.kind)}
            {@const actions = actionsOf(notice.kind)}
            <li>
              <span class="text">{shape?.text(notice.params, $language) ?? ''}</span>
              {#if actions.length > 0}
                <div class="row-actions">
                  {#each actions as action, index}
                    <button
                      class:primary={action.primary}
                      disabled={running.has(notice.id)}
                      on:click={() => act(notice, index)}
                    >
                      {t($language, action.label)}
                    </button>
                  {/each}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .bell-wrap { position: relative; }

  /* Les déclarations de `.bar-button` de `TopBar`, recopiées et non
     réinventées.

     Svelte scope les styles au composant, donc la classe du parent ne
     traverse pas ; mais ces valeurs sont toutes des propriétés
     personnalisées globales, donc les recopier rend exactement le même
     bouton. Inventer un bord et un fond ici mettrait une cloche étrangère
     à côté du casque et des amis - c'est mot pour mot la faute que
     `GameDetailsModal` a payée avec `.share`, livré en bouton brut du
     navigateur à côté de son voisin habillé. */
  .bell {
    position: relative;
    display: inline-flex;
    align-items: center;
    line-height: 1.25;
    background: var(--ground);
    border: var(--btn-border) solid var(--edge);
    box-shadow: var(--btn-bevel);
    color: var(--shell);
    font-family: var(--display);
    font-size: var(--btn-size);
    padding: var(--btn-pad);
    border-radius: var(--btn-radius);
    cursor: pointer;
  }

  .badge {
    position: absolute;
    top: -0.35rem;
    right: -0.35rem;
    min-width: 1.1rem;
    padding: 0 0.25rem;
    border-radius: 999px;
    background: #b8455a;
    color: #fff;
    font-size: 0.68rem;
    line-height: 1.1rem;
    font-weight: 600;
  }

  .panel {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    z-index: 1000;
    width: min(24rem, calc(100vw - 2rem));
    max-height: 60vh;
    overflow-y: auto;
    padding: 0.5rem;
    border-radius: 0.75rem;
    background: rgba(20, 20, 30, 0.97);
    border: 1px solid #2c2c3c;
  }

  ul { list-style: none; margin: 0; padding: 0; }

  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.75rem;
    align-items: center;
    padding: 0.6rem 0.5rem;
    border-bottom: 1px solid #24243a;
    color: #e6e6f0;
    font-size: 0.82rem;
  }

  li:last-child { border-bottom: none; }

  .text { flex: 1; min-width: 9rem; }

  .empty {
    margin: 0;
    padding: 1rem 0.5rem;
    color: #8b8ba3;
    font-size: 0.82rem;
    text-align: center;
  }

  .row-actions { display: flex; gap: 0.4rem; }

  button.primary { background: #2f6f4f; border-color: #3c8c64; }

  .row-actions button {
    padding: 0.3rem 0.7rem;
    border-radius: 999px;
    border: 1px solid #2c2c3c;
    background: #1b1b28;
    color: #e6e6f0;
    font-size: 0.78rem;
    cursor: pointer;
  }

  button:focus-visible { outline: 2px solid #6f8bff; outline-offset: 2px; }
</style>
