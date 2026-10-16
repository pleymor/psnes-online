<script lang="ts">
  /**
   * Créer un compte avec une adresse et un mot de passe -- derrière une
   * invitation, comme tout le monde.
   *
   * Le formulaire ne crée aucun compte : il envoie un mail, et c'est le clic
   * dans ce mail (`GET /auth/signup/confirm`) qui fait naître le compte. Un
   * refus à ce moment-là revient ici, en `?signupError=`.
   *
   * Le verdict de l'invitation est demandé au serveur avant d'afficher le
   * formulaire, pour la même raison que sur l'accueil : ne pas faire remplir un
   * formulaire à quelqu'un dont le lien a déjà servi. La porte est reconsultée
   * au POST, et c'est elle qui fait foi.
   */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t, type TranslationKey } from '$lib/i18n/translations';
  import { signupRefusalKey } from '$lib/auth/signup-refusal';
  import { setPageTitle } from '$lib/utils/page-title';
  import { createLogger } from '$lib/utils/logger';
  import AuthCard from '$lib/components/AuthCard.svelte';

  const logger = createLogger('SignupPage');

  let state: 'checking' | 'form' | 'sent' | 'refused' | 'none' = 'checking';
  let inviteCode = '';
  let refusalKey = '';

  let email = '';
  let password = '';
  let submitting = false;
  let errorKey = '';

  $: setPageTitle($language, t($language, 'signupTitle'));

  onMount(() => {
    const unsubscribe = user.subscribe(u => { if (u) void goto('/'); });
    void checkInvite();
    return unsubscribe;
  });

  async function checkInvite() {
    const params = new URLSearchParams(window.location.search);
    const returned = params.get('signupError');
    if (returned) {
      state = 'refused';
      refusalKey = signupRefusalKey(returned);
      return;
    }

    inviteCode = params.get('invite') ?? '';
    if (!inviteCode) {
      state = 'none';
      return;
    }

    try {
      const res = await fetch(`/auth/invite/${encodeURIComponent(inviteCode)}`);
      if (res.ok) {
        state = 'form';
        return;
      }
      const body = await res.json().catch(() => ({}));
      state = 'refused';
      refusalKey = signupRefusalKey(body?.error);
    } catch {
      state = 'refused';
      refusalKey = 'authUnavailable';
    }
  }

  async function submit() {
    if (submitting) return;
    submitting = true;
    errorKey = '';
    try {
      const res = await fetch('/auth/signup', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: inviteCode, email, password })
      });
      if (res.ok) {
        state = 'sent';
        return;
      }
      const body = await res.json().catch(() => ({}));
      errorKey = signupRefusalKey(body?.error);
    } catch (err) {
      logger.error('Password sign-up failed:', err);
      errorKey = 'authUnavailable';
    } finally {
      submitting = false;
    }
  }

  function text(key: string): string {
    return t($language, key as TranslationKey);
  }
</script>

<AuthCard title={t($language, 'signupTitle')}>
  {#if state === 'checking'}
    <p class="lead">{t($language, 'loading')}</p>
  {:else if state === 'none'}
    <p class="lead">
      {t($language, 'signupInviteOnly')}<br />
      <span class="hint">{t($language, 'signupInviteOnlyHint')}</span>
    </p>
  {:else if state === 'refused'}
    <p class="error" role="alert">{text(refusalKey)}</p>
    {#if refusalKey === 'signupTokenInvalid'}
      <!-- Un lien de confirmation « déjà servi » peut l'avoir été par
           l'analyseur de liens d'une messagerie, qui l'ouvre avant le
           destinataire : le compte existe alors, il n'y a qu'à se connecter. -->
      <p class="lead"><a href="/login">{t($language, 'loginWithPassword')}</a></p>
    {/if}
  {:else if state === 'sent'}
    <p class="ok" role="status">{t($language, 'signupCheckMail')}</p>
  {:else}
    <form on:submit|preventDefault={submit}>
      <label>
        {t($language, 'loginEmail')}
        <input type="email" bind:value={email} autocomplete="email" required />
      </label>
      <label>
        {t($language, 'loginPassword')}
        <input
          type="password"
          bind:value={password}
          autocomplete="new-password"
          minlength="10"
          required
          aria-describedby="password-hint"
        />
      </label>
      <p class="hint" id="password-hint">{t($language, 'signupPasswordHint')}</p>
      {#if errorKey}
        <p class="error" role="alert">{text(errorKey)}</p>
      {/if}
      <button type="submit" disabled={submitting}>{t($language, 'signupSubmit')}</button>
    </form>
  {/if}
</AuthCard>
