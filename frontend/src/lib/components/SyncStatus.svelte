<script lang="ts">
  /**
   * Ce que la synchronisation des sauvegardes est en train de faire (#71 §7.3).
   *
   * Deux formes pour un seul état. En entier dans le panneau ROM du profil et
   * dans la bibliothèque hors-ligne : le compteur « N sauvegardes en attente »,
   * la raison d'un échec en toutes lettres, et le geste pour réessayer. En
   * petit (`compact`) là où l'on joue : rien quand tout est parti - une partie
   * n'a pas à afficher « tout va bien » - et sinon une pastille discrète, qui
   * ne se tait pas sur un échec.
   *
   * Un échec n'est jamais silencieux, et c'est la règle de ce composant : une
   * synchronisation qui échoue sans le dire est une perte de données qu'on
   * découvre six mois plus tard.
   */
  import { language } from '$lib/stores/language';
  import { linkState } from '$lib/stores/connection';
  import { user } from '$lib/stores/user';
  import { t } from '$lib/i18n/translations';
  import { drainNow, syncStatus } from '$lib/saves/sync';
  import { shouldDrain, syncLineKey } from '$lib/saves/sync-rules';

  export let compact = false;

  $: status = $syncStatus;
  $: key = syncLineKey(status);
  $: lineText = t($language, key);
  $: failed = status.pending > 0 && status.failure !== null;
  $: canRetry = shouldDrain($linkState, !!$user) && status.pending > 0 && !status.draining;
  $: pendingText =
    status.pending === 1 ? t($language, 'syncPendingOne') : t($language, 'syncPending', { count: status.pending });
  $: keptText =
    status.kept === 1 ? t($language, 'syncKeptOne') : t($language, 'syncKept', { count: status.kept });
  $: offline = !shouldDrain($linkState, !!$user);
</script>

{#if compact}
  {#if status.pending > 0}
    <!-- `status`, pas `alert` : la pastille ne doit pas interrompre une partie
         à chaque écriture de la minuterie. L'échec, lui, est dit par sa
         couleur, son texte et son titre, et en entier sur le profil. -->
    <span
      class="badge"
      class:failed
      role="status"
      title={failed ? `${t($language, 'syncFailedPrefix')} ${lineText}` : pendingText}
      data-testid="sync-badge"
    >
      <span class="dot" aria-hidden="true"></span>
      {#if failed && !offline}
        {t($language, 'syncBadgeFailed')}
      {:else if offline}
        {t($language, 'syncBadgeOffline')}
      {:else}
        {t($language, 'syncBadgePending', { count: status.pending })}
      {/if}
    </span>
  {/if}
{:else}
  <div class="sync" data-testid="sync-status">
    {#if status.pending === 0}
      <p class="line ok">{t($language, 'syncAllSent')}</p>
    {:else}
      <p class="line" class:failed role={failed ? 'alert' : 'status'}>
        <strong>{pendingText}</strong>
        {#if failed}
          <span>{t($language, 'syncFailedPrefix')} {lineText}</span>
        {/if}
      </p>
      <p class="explain">{t($language, 'syncStaysLocal')}</p>
      {#if canRetry}
        <button class="retry" on:click={() => drainNow({ force: true })}>{t($language, 'syncRetry')}</button>
      {/if}
    {/if}
    {#if status.kept > 0}
      <p class="explain kept">{keptText}</p>
    {/if}
  </div>
{/if}

<style>
  .sync {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.35rem;
  }

  .line {
    margin: 0;
    font-size: 0.9rem;
    color: #e6e6f0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .line.ok {
    color: #9fe3b0;
  }

  .line.failed {
    color: #fca5a5;
  }

  .explain {
    margin: 0;
    font-size: 0.8rem;
    color: #9a9aae;
  }

  .kept {
    color: #fcd34d;
  }

  .retry {
    font-size: 0.85rem;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    font-size: 0.75rem;
    line-height: 1.2;
    color: #e6e6f0;
    background: rgba(20, 20, 30, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.14);
    pointer-events: auto;
    white-space: nowrap;
  }

  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: #fcd34d;
  }

  .badge.failed {
    border-color: rgba(248, 113, 113, 0.6);
    color: #fecaca;
  }

  .badge.failed .dot {
    background: #f87171;
  }
</style>
