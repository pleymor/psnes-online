<script lang="ts">
  /**
   * Choosing a language, as two visible choices rather than one toggle.
   *
   * A single button showing "EN" cannot say whether that is the current state
   * or the thing you are about to switch to - the old version's label read as
   * the state while its tooltip described the action. With only two languages
   * both fit on screen, so neither reading has to be guessed: each is named,
   * and the active one is marked.
   *
   * This is mounted on the signed-out landing page as well as the profile
   * page. Someone who reads neither language needs it before signing in,
   * which is why it cannot live on the profile page alone.
   */
  import { language } from '$lib/stores/language';

  const CHOICES = [
    { id: 'en', label: 'English' },
    { id: 'fr', label: 'Français' }
  ] as const;
</script>

<div class="language-selector" role="group" aria-label="Language">
  {#each CHOICES as choice}
    <button
      class="choice"
      class:on={$language === choice.id}
      aria-pressed={$language === choice.id}
      on:click={() => language.set(choice.id)}
    >
      {choice.label}
    </button>
  {/each}
</div>

<style>
  .language-selector {
    display: inline-flex;
    padding: 0.25rem;
    gap: 0.25rem;
    background: var(--panel);
    border: 2px solid var(--edge);
    border-radius: 12px;
  }

  /* Un segment de choix, pas une action : il ne prend ni le vert ni le
     rouge, et son état actif se dit comme celui de la barre - enfoncé, et
     l'or pour libellé. */
  .choice {
    background: transparent;
    border: none;
    box-shadow: none;
    border-radius: 8px;
    padding: 0.15rem 0.9rem;
    color: var(--muted);
    transition:
      background 0.15s,
      color 0.15s;
  }

  .choice:hover:not(.on) {
    color: var(--shell);
  }

  .choice.on {
    background: var(--ground);
    box-shadow: inset 0 4px 0 rgba(0, 0, 0, 0.4), inset 0 -4px 0 rgba(255, 255, 255, 0.08);
    color: var(--edge);
  }
</style>
