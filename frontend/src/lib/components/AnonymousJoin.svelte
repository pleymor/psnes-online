<script lang="ts">
  /**
   * La porte d'un salon pour qui n'a pas de compte.
   *
   * L'écran que voit quelqu'un à qui on a envoyé un lien de salon et qui ne
   * s'est jamais connecté - c'est-à-dire, la première fois, à peu près tout le
   * monde. Avant, cette page renvoyait vers Google, ce qui revenait à répondre
   * « inscrivez-vous » à « viens jouer ».
   *
   * C'est la présentation de la règle, pas la règle. Le serveur décide seul :
   * `POST /auth/anonymous` refuse un salon inexistant ou plein, une session
   * déjà ouverte, un pseudonyme mal formé et un débit trop élevé, et
   * `requirePseudo` refuse ensuite à cette session tout ce qui appartient à un
   * compte. Cet écran ne fait que rendre le refus lisible et ne pas offrir de
   * boutons dont on sait qu'ils échoueront.
   *
   * Le nom est facultatif : sans lui le serveur en attribue un, comme il le
   * fait pour un compte neuf. En demander un obligatoirement remettrait un
   * formulaire entre le lien et la partie, ce que cette porte existe
   * précisément pour retirer.
   */
  import { user, userLoading } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { isValidPseudo, PSEUDO_MIN, PSEUDO_MAX } from '$lib/pseudo';
  import { anonymousDoorMessage, anonymousJoinState } from '$lib/rooms/anonymous-join';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('AnonymousJoin');

  export let roomId: string;
  /** Faux quand le déploiement a fermé la porte (`ANONYMOUS_JOIN=off`). */
  export let enabled = true;

  let pseudo = '';
  let submitting = false;
  let error = '';

  $: state = anonymousJoinState({
    user: $user,
    loading: $userLoading,
    enabled,
    roomId
  });

  // Vivant, mais seulement une fois que quelque chose a été tapé : un champ
  // facultatif qui se déclare invalide avant qu'on y touche est un reproche.
  $: malformed = pseudo.length > 0 && !isValidPseudo(pseudo);
  $: canSubmit = !submitting && !malformed;

  async function join() {
    if (!canSubmit) return;

    submitting = true;
    error = '';

    try {
      const res = await fetch('/auth/anonymous', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // Le pseudonyme vide n'est pas envoyé : « absent » et « refusé » sont
        // deux choses, et le serveur attribue un nom pour la première.
        body: JSON.stringify(pseudo ? { roomId, pseudo } : { roomId })
      });

      if (res.ok) {
        // Poser l'utilisateur suffit : la mise en page ouvre le socket dès
        // qu'il existe, et la page de salon émet `room:join` à ce moment-là.
        // Un rechargement referait la requête d'authentification et perdrait
        // la page derrière.
        user.set(await res.json());
        return;
      }

      const body = await res.json().catch(() => ({}));
      const key = anonymousDoorMessage(res.status, body.error);
      error = key === 'pseudoInvalid'
        ? t($language, 'pseudoInvalid', { min: PSEUDO_MIN, max: PSEUDO_MAX })
        : t($language, key);
    } catch (err) {
      logger.error('Anonymous join failed:', err);
      error = t($language, 'anonymousJoinFailed');
    } finally {
      submitting = false;
    }
  }
</script>

{#if state.kind === 'offer' || state.kind === 'signInOnly'}
  <div class="door">
    <div class="card">
      <h1>{t($language, 'anonymousJoinTitle')}</h1>

      {#if state.kind === 'offer'}
        <p class="lead">{t($language, 'anonymousJoinLead')}</p>

        <form on:submit|preventDefault={join}>
          <input
            type="text"
            bind:value={pseudo}
            placeholder={t($language, 'anonymousNamePlaceholder')}
            maxlength={PSEUDO_MAX}
            autocomplete="off"
            aria-invalid={malformed}
          />
          {#if malformed}
            <p class="error">{t($language, 'pseudoInvalid', { min: PSEUDO_MIN, max: PSEUDO_MAX })}</p>
          {/if}

          <button type="submit" disabled={!canSubmit}>
            {submitting ? t($language, 'anonymousJoining') : t($language, 'anonymousJoinCta')}
          </button>
        </form>
      {:else}
        <p class="lead">{t($language, 'anonymousDisabled')}</p>
      {/if}

      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      <!-- Une ancre et pas un fetch : c'est une redirection OAuth. -->
      <a class="sign-in" href="/auth/google">{t($language, 'anonymousOrSignIn')}</a>
    </div>
  </div>
{/if}

<style>
  .door {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 1.5rem;
    background: #12121a;
    z-index: 900;
  }

  .card {
    width: min(26rem, 100%);
    padding: 2rem;
    border-radius: 1rem;
    background: #1e1e2a;
    color: #f2f2f5;
    text-align: center;
  }

  h1 {
    margin: 0 0 0.75rem;
    font-size: 1.35rem;
  }

  .lead {
    margin: 0 0 1.5rem;
    color: #b9b9c6;
    line-height: 1.5;
  }

  form {
    display: grid;
    gap: 0.75rem;
  }

  input {
    padding: 0.75rem 1rem;
    border: 1px solid #3a3a4a;
    border-radius: 0.5rem;
    background: #14141d;
    color: inherit;
    font-size: 1rem;
  }

  input[aria-invalid='true'] {
    border-color: #e2565c;
  }

  button {
    padding: 0.8rem 1rem;
    border: 0;
    border-radius: 0.5rem;
    background: #667eea;
    color: #fff;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .error {
    margin: 0.75rem 0 0;
    color: #e2565c;
    font-size: 0.9rem;
  }

  .sign-in {
    display: inline-block;
    margin-top: 1.5rem;
    color: #9aa0ff;
    font-size: 0.9rem;
  }
</style>
