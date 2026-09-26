<script lang="ts">
  /**
   * Les deux places d'un joueur.
   *
   * Le composant ne calcule pas le restant : il affiche celui que le serveur
   * annonce. Un compteur recalculé côté client dériverait du serveur au
   * premier cas limite (un lien révoqué par une autre session, un filleul
   * arrivé entre deux chargements) et donnerait un chiffre faux avec aplomb.
   */
  import { onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('MyInvites');

  interface InviteView {
    id: string;
    code: string;
    url: string;
    usedAt: string | null;
    inviteePseudo: string | null;
  }

  // Les erreurs qu'une tentative de création peut produire ; les nommer ici
  // évite le cast `as TranslationKey` (qui ne s'analyse pas dans le
  // template). `invitesLoadFailed` est distincte : elle ne vient jamais
  // d'une mutation, seulement d'un chargement qui a échoué.
  type MintErrorKey = 'invitesSpent' | 'invitesPlatformFull' | 'inviteMintFailed';
  type InviteError = MintErrorKey | 'invitesLoadFailed';

  /**
   * 403 et 503 ne veulent pas dire la même chose pour un joueur : l'un est
   * son propre quota épuisé (un message qui existe déjà et qui est le bon),
   * l'autre est la plateforme entière qui est pleine. Une fonction nommée
   * plutôt qu'un ternaire à deux branches, mais pas un module à part : l'ordre
   * des trois cas ne porte aucune décision à figer par un test, contrairement
   * à `signupDoorDecision`.
   */
  function mintErrorKey(code: unknown): MintErrorKey {
    if (code === 'QUOTA_EXHAUSTED') return 'invitesSpent';
    if (code === 'PLATFORM_FULL') return 'invitesPlatformFull';
    return 'inviteMintFailed';
  }

  let quota = 0;
  let remaining = 0;
  let platformFull = false;
  let invites: InviteView[] = [];
  let loading = true;
  let minting = false;
  let revokingId: string | null = null;
  let error: InviteError | '' = '';
  let copied: string | null = null;

  /**
   * Recharge quota/remaining/platformFull/invites depuis le serveur, sans
   * toucher `loading` ni `error`.
   *
   * Utilisée après une mutation (créer, retirer) pour resynchroniser
   * l'affichage sur l'état réel du serveur - y compris quand la mutation
   * elle-même a échoué, puisque c'est justement le signe que l'état affiché
   * datait d'avant un changement arrivé ailleurs (un lien révoqué par une
   * autre session, un filleul arrivé entre deux chargements). `load()` s'en
   * sert pour le chargement initial ; les gestes qui ont déjà un message à
   * montrer l'appellent directement pour ne pas l'effacer.
   */
  async function refresh(): Promise<boolean> {
    try {
      const res = await fetch('/api/invites', { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      quota = body.quota;
      remaining = body.remaining;
      platformFull = body.platformFull;
      invites = body.invites;
      return true;
    } catch (err) {
      logger.error('Could not load invitations', err);
      return false;
    }
  }

  async function load(): Promise<void> {
    loading = true;
    error = '';
    const ok = await refresh();
    if (!ok) error = 'invitesLoadFailed';
    loading = false;
  }

  async function mint(): Promise<void> {
    error = '';
    minting = true;
    try {
      const res = await fetch('/api/invites', { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Le message d'abord, puis la resynchronisation : sinon le bouton
        // resterait actif et le compte resterait faux avec aplomb, ce que
        // le composant se reproche à lui-même plus haut.
        error = mintErrorKey(body?.error);
        await refresh();
        return;
      }
      await refresh();
    } catch (err) {
      logger.error('Could not create an invitation', err);
      error = 'inviteMintFailed';
    } finally {
      minting = false;
    }
  }

  async function revoke(id: string): Promise<void> {
    if (revokingId) return;
    revokingId = id;
    try {
      // Une 409/404 est absorbée par le `refresh()` inconditionnel qui suit :
      // la liste redevient exacte que le lien ait déjà servi ou n'existe
      // plus. Seul un échec réseau (la promesse elle-même rejetée) mérite
      // d'être rattrapé ici.
      await fetch(`/api/invites/${id}`, { method: 'DELETE', credentials: 'include' });
      // `refresh()` ne touche jamais `error` - à dessein, pour que `mint()`
      // puisse poser son message puis resynchroniser sans se l'effacer. Ici
      // c'est l'inverse qu'il faut : un retrait qui aboutit est un nouveau
      // geste réussi, et un message laissé par une tentative de création
      // précédente ("vous avez donné vos deux places") ne décrirait plus
      // l'état qui va s'afficher juste après - potentiellement une place
      // libérée à l'instant par ce même retrait.
      error = '';
      await refresh();
    } catch (err) {
      logger.error('Could not withdraw the invitation', err);
    } finally {
      revokingId = null;
    }
  }

  async function copy(invite: InviteView): Promise<void> {
    try {
      await navigator.clipboard.writeText(invite.url);
      copied = invite.id;
      setTimeout(() => {
        if (copied === invite.id) copied = null;
      }, 2000);
    } catch (err) {
      // Un presse-papiers refusé (origine non sécurisée, permission refusée)
      // ne mérite pas une bannière d'erreur : le lien reste affiché et peut
      // être sélectionné à la main.
      logger.error('Could not copy the invite link', err);
    }
  }

  /**
   * Pourquoi la carte ne peut rien faire ici, ou null.
   *
   * Hors-ligne, ou sans compte : les invitations sont sur le serveur. La
   * carte garde sa place et son bouton, éteint, et dit pourquoi ; elle ne
   * demande rien, puisque la réponse ne viendrait pas.
   */
  export let unavailable: string | null = null;

  onMount(() => {
    if (!unavailable) void load();
  });
</script>

<section class="my-invites">
  <h2>{t($language, 'myInvites')}</h2>

  {#if unavailable}
    <p class="note">{unavailable}</p>
    <button disabled title={unavailable}>{t($language, 'mintInvite')}</button>
  {:else if loading}
    <p class="note">{t($language, 'loading')}</p>
  {:else if error === 'invitesLoadFailed'}
    <!-- Un chargement raté n'est pas une liste vide : ne pas afficher
         "vous n'avez encore invité personne" à côté d'un compte à 0/0
         auquel il ne faut pas croire. -->
    <p class="note error">
      {t($language, 'invitesLoadFailed')}
      <button class="retry" on:click={load}>{t($language, 'retry')}</button>
    </p>
  {:else}
    <p class="remaining">
      <strong>{remaining} / {quota}</strong>
      {t($language, 'invitesRemaining')}
    </p>

    {#if error}
      <p class="note error">{t($language, error)}</p>
    {/if}

    <button on:click={mint} disabled={remaining === 0 || platformFull || minting}>
      {t($language, 'mintInvite')}
    </button>

    {#if remaining === 0 && !error}
      <p class="note">{t($language, 'invitesSpent')}</p>
    {:else if platformFull && !error}
      <!-- `remaining > 0` ici : sinon la branche du dessus a déjà expliqué le
           bouton mort. Sans cette branche, un joueur qui a encore des places
           mais tombe sur une plateforme pleine voit un bouton désactivé sans
           un mot -- et ne peut jamais envoyer le POST qui aurait affiché
           `invitesPlatformFull` comme erreur, puisque c'est ce même bouton
           désactivé qui l'en empêche. -->
      <p class="note">{t($language, 'invitesPlatformFull')}</p>
    {/if}

    <div class="list">
      {#if invites.length === 0}
        <p class="note">{t($language, 'invitesNone')}</p>
      {:else}
        {#each invites as invite (invite.id)}
          <div class="invite">
            {#if invite.usedAt}
              <span class="joined">
                <strong>{invite.inviteePseudo}</strong>
                {t($language, 'inviteJoined')}
              </span>
            {:else}
              <code class="link">{invite.url}</code>
              <div class="actions">
                <button class="copy" on:click={() => copy(invite)}>
                  {copied === invite.id ? t($language, 'inviteCopied') : t($language, 'inviteCopy')}
                </button>
                <button
                  class="revoke"
                  disabled={revokingId === invite.id}
                  on:click={() => revoke(invite.id)}
                >
                  {t($language, 'inviteRevoke')}
                </button>
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</section>

<style>
  /* Le même bloc visuel que les autres cartes de la page de profil,
     recopié ici : les styles Svelte sont portés par composant, donc
     `.card` défini dans +page.svelte n'atteint pas ce composant-ci.
     Même choix que RomSourcePanel. */
  .my-invites {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 14px;
    padding: 1.25rem;
  }

  h2 {
    margin: 0 0 0.75rem;
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9aa0b4;
  }

  .remaining {
    margin: 0 0 0.75rem;
    font-size: 0.9rem;
    color: #ccc;
  }

  .remaining strong {
    color: #9fb4ff;
  }

  .note {
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
    opacity: 0.75;
    line-height: 1.4;
  }

  .note.error {
    opacity: 1;
    color: #ff8a80;
  }

  .retry {
    margin-left: 0.5rem;
    padding: 0.1rem 0.6rem;
    font-size: 0.8rem;
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .list {
    margin-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .invite {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding: 0.6rem 0.75rem;
    background: #1a1a1a;
    border-radius: 8px;
    font-size: 0.85rem;
  }

  .link {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #9fb4ff;
    overflow-wrap: anywhere;
    min-width: 0;
  }

  .joined {
    color: #aaa;
  }

  .actions {
    display: flex;
    gap: 0.5rem;
    flex: 0 0 auto;
  }

  .actions button {
    padding: 0.2rem 0.6rem;
    font-size: 0.8rem;
  }

  .revoke {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
  }
</style>
