<script lang="ts">
  /**
   * Se connecter avec une adresse et un mot de passe, ou demander un lien
   * quand on l'a oublié.
   *
   * « Mot de passe oublié » est dépliant, dans la même page : c'est le chemin
   * de secours de cet écran-ci, pas une destination. Et il affiche le même
   * message quelle que soit la réponse -- le serveur répond toujours 200 pour
   * ne pas dire quelles adresses ont un compte, et l'écran ne doit pas laisser
   * croire le contraire.
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

  const logger = createLogger('LoginPage');

  let email = '';
  let password = '';
  let submitting = false;
  let errorKey = '';

  let forgotOpen = false;
  let forgotEmail = '';
  let forgotSending = false;
  let forgotSent = false;

  $: setPageTitle($language, t($language, 'loginTitle'));

  // Déjà connecté : rien à faire ici.
  onMount(() => user.subscribe(u => { if (u) void goto('/'); }));

  async function signIn() {
    if (submitting) return;
    submitting = true;
    errorKey = '';
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (res.ok) {
        user.set(await res.json());
        await goto('/');
        return;
      }
      const body = await res.json().catch(() => ({}));
      errorKey = signupRefusalKey(body?.error);
    } catch (err) {
      logger.error('Password sign-in failed:', err);
      errorKey = 'authUnavailable';
    } finally {
      submitting = false;
    }
  }

  async function sendLink() {
    if (forgotSending) return;
    forgotSending = true;
    try {
      await fetch('/auth/forgot', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail })
      });
    } catch (err) {
      // Rien à dire de plus au visiteur : le message est le même dans tous les
      // cas, c'est tout son intérêt.
      logger.error('Password reset request failed:', err);
    } finally {
      forgotSending = false;
      forgotSent = true;
    }
  }

  function text(key: string): string {
    return t($language, key as TranslationKey);
  }
</script>

<AuthCard title={t($language, 'loginTitle')}>
  <form on:submit|preventDefault={signIn}>
    <label>
      {t($language, 'loginEmail')}
      <input type="email" bind:value={email} autocomplete="email" required />
    </label>
    <label>
      {t($language, 'loginPassword')}
      <input type="password" bind:value={password} autocomplete="current-password" required />
    </label>
    {#if errorKey}
      <p class="error" role="alert">{text(errorKey)}</p>
    {/if}
    <button type="submit" disabled={submitting}>{t($language, 'loginSubmit')}</button>
  </form>

  {#if !forgotOpen}
    <p>
      <button
        type="button"
        class="link-button"
        on:click={() => { forgotOpen = true; forgotEmail = forgotEmail || email; }}
      >
        {t($language, 'loginForgot')}
      </button>
    </p>
  {:else if forgotSent}
    <p class="ok" role="status">{t($language, 'loginForgotSent')}</p>
  {:else}
    <form on:submit|preventDefault={sendLink}>
      <label>
        {t($language, 'loginEmail')}
        <input type="email" bind:value={forgotEmail} autocomplete="email" required />
      </label>
      <button type="submit" disabled={forgotSending}>{t($language, 'loginSend')}</button>
    </form>
  {/if}
</AuthCard>

<style>
  p {
    margin: 1rem 0 0;
  }
</style>
