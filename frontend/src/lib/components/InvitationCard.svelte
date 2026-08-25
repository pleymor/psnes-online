<script lang="ts">
  /**
   * An invitation, in front of the player, wherever they are.
   *
   * Not a toast: an invitation is worth ten minutes and has no business
   * evaporating after three seconds. It is a pinned card with two buttons, and
   * accepting is one click - which is the whole reason this component exists.
   * The badge-and-drawer it replaces was two clicks, on two pages out of the
   * whole application.
   */
  import { onMount, onDestroy } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { inGame } from '$lib/stores/in-game';
  import {
    invitations,
    answering,
    invitationError,
    acceptInvitation,
    declineInvitation
  } from '$lib/lobby/invitations';

  let now = Date.now();
  let clock: ReturnType<typeof setInterval> | undefined;

  onMount(() => {
    // Ticks the expiry label, and drops a card by itself when the ten minutes
    // run out with nobody having answered - no broadcast comes for that,
    // because nothing happened on the server.
    clock = setInterval(() => (now = Date.now()), 15_000);
  });

  onDestroy(() => clearInterval(clock));

  /**
   * The invitations still standing at this instant.
   *
   * The server filters expired ones when it hands them over, but a card left on
   * screen outlives that answer: without a clock of its own this would go on
   * offering an invitation the server will now refuse.
   */
  $: live = $invitations.filter((i) => new Date(i.expiresAt).getTime() > now);

  /**
   * `at` and `lang` are arguments rather than reads of `now` and `$language`, so
   * the template tracks them: in Svelte 4 an expression whose dependencies are
   * only hidden inside a function body never re-runs when they change, and this
   * one has to tick.
   */
  function expiryLabel(expiresAt: string, at: number, lang: 'en' | 'fr'): string {
    const minutes = Math.ceil((new Date(expiresAt).getTime() - at) / 60_000);
    return minutes <= 1
      ? t(lang, 'expiresInAMinute')
      : t(lang, 'expiresInMinutes', { count: minutes });
  }
</script>

<!-- Out of the way while a game is running: a panel over an emulator steals a
     click, and accepting would walk the player out of the match. -->
{#if live.length > 0 && !$inGame}
  <div class="invitation-stack">
    {#each live as invitation (invitation.id)}
      <div class="invitation" role="alert">
        <div class="avatar">
          {#if invitation.fromAvatar}
            <img src={invitation.fromAvatar} alt="" />
          {:else}
            👤
          {/if}
        </div>
        <div class="what">
          <strong>{t($language, 'invitedYou', { name: invitation.fromPseudo })}</strong>
          <!-- A room can be waiting with no game at all now, so there is nothing
               to name - say that rather than show an empty line. -->
          <small>{invitation.gameTitle ?? t($language, 'noGameChosen')}</small>
          <small class="expiry">{expiryLabel(invitation.expiresAt, now, $language)}</small>
          {#if $invitationError && $answering === null}
            <small class="error">{$invitationError}</small>
          {/if}
        </div>
        <div class="answers">
          <button
            class="accept"
            disabled={$answering === invitation.id}
            on:click={() => acceptInvitation(invitation.id)}
          >
            {t($language, 'accept')}
          </button>
          <button
            class="decline"
            disabled={$answering === invitation.id}
            on:click={() => declineInvitation(invitation.id)}
          >
            {t($language, 'decline')}
          </button>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .invitation-stack {
    position: fixed;
    /* Below the top bar rather than over it: the bar is 49px tall on the two
       pages that carry one, and a card across it hides the friends button and
       the avatar. */
    top: 4rem;
    right: 1rem;
    z-index: 2500;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: min(24rem, calc(100vw - 2rem));
  }

  .invitation {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    background: rgba(30, 30, 30, 0.97);
    border: 1px solid rgba(102, 126, 234, 0.45);
    border-left: 4px solid #667eea;
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(10px);
    animation: slideIn 0.25s ease-out;
  }

  @keyframes slideIn {
    from {
      transform: translateX(1rem);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  .avatar {
    width: 2.5rem;
    height: 2.5rem;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: #2a2a2a;
    overflow: hidden;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .what {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }

  .what strong {
    font-size: 0.9375rem;
    color: #fff;
  }

  .what small {
    font-size: 0.8125rem;
    color: #aaa;
  }

  .expiry {
    color: #888 !important;
  }

  .error {
    color: #ff8a80 !important;
  }

  .answers {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    flex: 0 0 auto;
  }

  .answers button {
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .answers button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .accept {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: #fff;
  }

  .decline {
    background: rgba(68, 68, 68, 0.9);
    color: #ddd;
  }

  @media (max-width: 480px) {
    .invitation-stack {
      left: 1rem;
      max-width: none;
    }
  }
</style>
