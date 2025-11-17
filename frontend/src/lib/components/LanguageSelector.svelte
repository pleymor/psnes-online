<script lang="ts">
  import { language } from '$lib/stores/language';

  function setLanguage(lang: 'en' | 'fr') {
    language.set(lang);
  }
</script>

<div class="language-selector">
  <button
    class="lang-btn"
    class:active={$language === 'en'}
    on:click={() => setLanguage('en')}
    title="English"
  >
    🇬🇧
  </button>
  <button
    class="lang-btn"
    class:active={$language === 'fr'}
    on:click={() => setLanguage('fr')}
    title="Français"
  >
    🇫🇷
  </button>
</div>

<style>
  .language-selector {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .lang-btn {
    background: rgba(255, 255, 255, 0.1);
    border: 2px solid transparent;
    border-radius: 6px;
    padding: 0.25rem 0.5rem;
    font-size: 1.25rem;
    cursor: pointer;
    transition: all 0.2s;
    line-height: 1;
  }

  .lang-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .lang-btn.active {
    border-color: #667eea;
    background: rgba(102, 126, 234, 0.2);
  }
</style>
