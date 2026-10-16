<script lang="ts">
  /**
   * Le cadre commun des trois écrans de la porte e-mail + mot de passe
   * (`/login`, `/signup`, `/reset`).
   *
   * Un composant plutôt que trois copies : ce sont trois formulaires courts qui
   * doivent se ressembler au pixel près, et l'accueil (`routes/+page.svelte`)
   * reste la porte d'entrée -- d'où le lien de retour, toujours au même
   * endroit.
   *
   * Les champs et boutons glissés dans le cadre sont stylés ici par `:global`
   * sous `.auth-card` : Svelte rattache le contenu d'un slot au composant qui
   * l'écrit, donc sans cela chaque page répéterait les mêmes règles.
   */
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import LanguageSelector from '$lib/components/LanguageSelector.svelte';

  export let title: string;
</script>

<main class="auth-page">
  <div class="auth-card">
    <h1>{title}</h1>
    <slot />
    <div class="auth-footer">
      <LanguageSelector />
      <a href="/">{t($language, 'loginBack')}</a>
    </div>
  </div>
</main>

<style>
  .auth-page {
    display: grid;
    place-items: center;
    min-height: 100vh;
    padding: 1.5rem 1rem;
  }

  .auth-card {
    width: min(26rem, 100%);
    padding: 2rem 1.5rem;
    border-radius: 1rem;
    background: #1e1e2a;
    color: #f2f2f5;
    text-align: center;
  }

  h1 {
    margin: 0 0 1.25rem;
    font-size: 1.35rem;
  }

  .auth-card :global(form) {
    display: grid;
    gap: 0.75rem;
    text-align: left;
  }

  .auth-card :global(label) {
    display: grid;
    gap: 0.35rem;
    font-size: 0.9rem;
    color: #b9b9c6;
  }

  .auth-card :global(input) {
    padding: 0.75rem 1rem;
    border: 1px solid #3a3a4a;
    border-radius: 0.5rem;
    background: #14141d;
    color: inherit;
    font-size: 1rem;
  }

  .auth-card :global(button[type='submit']) {
    margin-top: 0.25rem;
    padding: 0.55rem 1rem;
    background: var(--go);
    border-color: var(--go-deep);
    color: #ffffff;
  }

  .auth-card :global(button:disabled) {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .auth-card :global(.hint) {
    margin: 0;
    font-size: 0.8125rem;
    color: #888;
  }

  .auth-card :global(.lead) {
    margin: 0 0 1rem;
    color: #b9b9c6;
    line-height: 1.5;
  }

  .auth-card :global(.ok) {
    margin: 0;
    color: var(--go);
    line-height: 1.5;
  }

  .auth-card :global(.error) {
    margin: 0;
    color: #e2565c;
    font-size: 0.9rem;
  }

  /* Un lien, pas un second bouton : la même retenue que « jouer sans compte »
     sur l'accueil. */
  .auth-card :global(.link-button) {
    background: none;
    border: none;
    box-shadow: none;
    padding: 0.25rem;
    font-family: inherit;
    font-size: 0.9rem;
    color: #9aa0ff;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .auth-footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1.5rem;
    font-size: 0.9rem;
  }

  .auth-footer a {
    color: #9aa0ff;
  }
</style>
