<script lang="ts">
  /**
   * The one screen a player cannot leave without answering.
   *
   * An overlay rather than a route. Someone who opens a `/room/abc123` link
   * from a message keeps that URL behind this, and the room is already there
   * when they submit - a redirect to a dedicated page would have to remember
   * and restore the destination, and would get it wrong the first time nobody
   * tested it.
   *
   * This is the presentation of the rule, not the rule. The server refuses
   * every business route and every socket from an account with no chosen
   * pseudonym (middleware/auth.ts:requirePseudo), which is what survives curl
   * and a valid session cookie.
   */
  import { user } from '$lib/stores/user';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { isValidPseudo, PSEUDO_MIN, PSEUDO_MAX, formatHandle } from '$lib/pseudo';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('PseudoGate');

  let pseudo = '';
  let submitting = false;
  let error = '';

  // Live, but only once they have typed something: telling someone their empty
  // field is invalid before they have touched it is scolding, not helping.
  $: malformed = pseudo.length > 0 && !isValidPseudo(pseudo);
  $: canSubmit = isValidPseudo(pseudo) && !submitting;

  async function submit() {
    if (!canSubmit) return;

    submitting = true;
    error = '';

    try {
      const res = await fetch('/api/pseudo', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pseudo })
      });

      if (res.ok) {
        const handle = await res.json();
        // Clearing needsPseudo is what takes this overlay down and lets the
        // layout open the socket. The store is updated rather than the page
        // reloaded, so the room behind us survives.
        user.update(current => current && { ...current, ...handle, needsPseudo: false });
        return;
      }

      const body = await res.json().catch(() => ({}));
      error = body.error === 'PSEUDO_FULL'
        ? t($language, 'pseudoFull')
        : body.error === 'PSEUDO_INVALID'
        ? t($language, 'pseudoRules', { min: PSEUDO_MIN, max: PSEUDO_MAX })
        : t($language, 'pseudoFailed');
    } catch (err) {
      logger.error('Could not claim a pseudonym', err);
      error = t($language, 'pseudoFailed');
    } finally {
      submitting = false;
    }
  }
</script>

<!--
  role="dialog" with aria-modal, and no close affordance of any kind: no
  backdrop click, no Escape handler, no cross. The page underneath carries the
  native `inert` attribute (set in +layout.svelte), which removes it from the
  tab order, the pointer and the accessibility tree in one go - a hand-rolled
  focus trap is worked around by the first autofocus somebody forgets.
-->
<div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="pseudo-gate-title">
  <div class="panel">
    {#if $user?.avatar}
      <img class="avatar" src={$user.avatar} alt="" />
    {/if}

    <h1 id="pseudo-gate-title">{t($language, 'choosePseudoTitle')}</h1>
    <p class="lead">{t($language, 'choosePseudoLead')}</p>

    <form on:submit|preventDefault={submit}>
      <!-- svelte-ignore a11y-autofocus -->
      <input
        type="text"
        bind:value={pseudo}
        autofocus
        autocomplete="off"
        spellcheck="false"
        maxlength={PSEUDO_MAX}
        placeholder={t($language, 'pseudoPlaceholder')}
        aria-describedby="pseudo-gate-rules"
        aria-invalid={malformed}
      />

      <p id="pseudo-gate-rules" class="rules" class:bad={malformed}>
        {t($language, 'pseudoRules', { min: PSEUDO_MIN, max: PSEUDO_MAX })}
      </p>

      {#if pseudo && !malformed}
        <!-- The discriminator is the server's to give, so it is shown as a
             placeholder rather than guessed at. -->
        <p class="preview">{formatHandle(pseudo, '····')}</p>
      {/if}

      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}

      <button type="submit" disabled={!canSubmit}>
        {submitting ? t($language, 'saving') : t($language, 'confirm')}
      </button>
    </form>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgba(10, 10, 12, 0.92);
  }

  .panel {
    width: min(26rem, 100%);
    padding: 2rem;
    border-radius: 12px;
    background: #232329;
    color: #f2f2f4;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    text-align: center;
  }

  .avatar {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    object-fit: cover;
    margin-bottom: 1rem;
  }

  h1 {
    margin: 0 0 0.5rem;
    font-size: 1.35rem;
  }

  .lead {
    margin: 0 0 1.5rem;
    color: #b6b6bf;
    font-size: 0.92rem;
    line-height: 1.45;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.7rem 0.85rem;
    border: 1px solid #3d3d46;
    border-radius: 8px;
    background: #1a1a1e;
    color: inherit;
    font-size: 1rem;
  }

  input:focus {
    outline: 2px solid #667eea;
    outline-offset: 1px;
  }

  .rules {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    color: #8f8f99;
  }

  .rules.bad {
    color: #ff8a80;
  }

  .preview {
    margin: 0.75rem 0 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 1rem;
    color: #9fb4ff;
  }

  .error {
    margin: 0.75rem 0 0;
    font-size: 0.85rem;
    color: #ff8a80;
  }

  button {
    width: 100%;
    margin-top: 1.25rem;
    padding: 0.7rem 1rem;
    border: 0;
    border-radius: 8px;
    /* Pas le #667eea de la marque : 3.66:1 sous du blanc, sous les 4.5
       qu'AA demande. Même teinte, assombrie jusqu'à 4.96:1. */
    background: #4764e6;
    color: #fff;
    font-size: 1rem;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
