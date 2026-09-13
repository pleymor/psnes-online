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

  // Les deux seules erreurs que ce composant montre ; les nommer ici évite
  // le cast `as TranslationKey` (qui ne s'analyse pas dans le template).
  type InviteError = 'inviteMintFailed' | 'invitesPlatformFull';

  let quota = 0;
  let remaining = 0;
  let platformFull = false;
  let invites: InviteView[] = [];
  let loading = true;
  let minting = false;
  let error: InviteError | '' = '';
  let copied: string | null = null;

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      const res = await fetch('/api/invites', { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      quota = body.quota;
      remaining = body.remaining;
      platformFull = body.platformFull;
      invites = body.invites;
    } catch (err) {
      logger.error('Could not load invitations', err);
      error = 'inviteMintFailed';
    } finally {
      loading = false;
    }
  }

  async function mint(): Promise<void> {
    error = '';
    minting = true;
    try {
      const res = await fetch('/api/invites', { method: 'POST', credentials: 'include' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        error = body?.error === 'PLATFORM_FULL' ? 'invitesPlatformFull' : 'inviteMintFailed';
        return;
      }
      await load();
    } finally {
      minting = false;
    }
  }

  async function revoke(id: string): Promise<void> {
    await fetch(`/api/invites/${id}`, { method: 'DELETE', credentials: 'include' });
    await load();
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

  onMount(load);
</script>

<section class="my-invites">
  <h2>{t($language, 'myInvites')}</h2>

  {#if loading}
    <p class="note">{t($language, 'loading')}</p>
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
                <button class="revoke" on:click={() => revoke(invite.id)}>
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
