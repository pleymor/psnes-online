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
    padding: 0.2rem;
    gap: 0.2rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
  }

  .choice {
    background: transparent;
    border: none;
    border-radius: 8px;
    padding: 0.45rem 0.9rem;
    font-size: 0.9rem;
    font-weight: 600;
    color: #aaa;
    cursor: pointer;
    transition:
      background 0.15s,
      color 0.15s;
  }

  .choice:hover:not(.on) {
    background: rgba(255, 255, 255, 0.06);
    color: #ddd;
  }

  .choice.on {
    background: #667eea;
    color: #fff;
  }
</style>
