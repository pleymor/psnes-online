<script lang="ts">
  import { language } from '$lib/stores/language';

  function toggleLanguage() {
    language.set($language === 'en' ? 'fr' : 'en');
  }

  $: currentFlag = $language === 'en' ? '🇬🇧' : '🇫🇷';
  $: currentTitle = $language === 'en' ? 'Switch to Français' : 'Switch to English';
</script>

<div class="language-selector">
  <button
    class="lang-btn"
    on:click={toggleLanguage}
    title={currentTitle}
  >
    {currentFlag}
  </button>
</div>

<style>
  .language-selector {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .lang-btn {
    background: rgba(255, 255, 255, 0.1);
    border: 2px solid rgba(102, 126, 234, 0.3);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    font-size: 1.5rem;
    cursor: pointer;
    transition: all 0.2s;
    line-height: 1;
  }

  .lang-btn:hover {
    background: rgba(102, 126, 234, 0.2);
    border-color: #667eea;
    transform: scale(1.05);
  }

  .lang-btn:active {
    transform: scale(0.95);
  }
</style>
