<script lang="ts">
  /**
   * Choisir un nouveau mot de passe, depuis le lien reçu par mail.
   *
   * Le jeton reste dans l'URL et part dans le corps du POST ; c'est le serveur
   * qui dit s'il vaut encore quelque chose (une heure, une seule fois).
   * L'avertissement sous le bouton n'est pas décoratif : enregistrer ferme
   * toutes les sessions du compte, y compris celle du casque.
   */
  import { goto } from '$app/navigation';
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t, type TranslationKey } from '$lib/i18n/translations';
  import { signupRefusalKey } from '$lib/auth/signup-refusal';
  import { setPageTitle } from '$lib/utils/page-title';
  import { createLogger } from '$lib/utils/logger';
  import AuthCard from '$lib/components/AuthCard.svelte';

  const logger = createLogger('ResetPage');

  let password = '';
  let submitting = false;
  let errorKey = '';

  $: setPageTitle($language, t($language, 'resetTitle'));

  async function submit() {
    if (submitting) return;
    submitting = true;
    errorKey = '';
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    try {
      const res = await fetch('/auth/reset', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      if (res.ok) {
        user.set(await res.json());
        await goto('/');
        return;
      }
      const body = await res.json().catch(() => ({}));
      errorKey = signupRefusalKey(body?.error);
    } catch (err) {
      logger.error('Password reset failed:', err);
      errorKey = 'authUnavailable';
    } finally {
      submitting = false;
    }
  }

  function text(key: string): string {
    return t($language, key as TranslationKey);
  }
</script>

<AuthCard title={t($language, 'resetTitle')}>
  <form on:submit|preventDefault={submit}>
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
    <button type="submit" disabled={submitting}>{t($language, 'resetSubmit')}</button>
    <p class="hint">{t($language, 'resetWillSignOut')}</p>
  </form>
</AuthCard>
