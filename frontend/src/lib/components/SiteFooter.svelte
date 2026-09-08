<script lang="ts">
  /**
   * Le pied de page de l'accueil : le lien vers la documentation, et l'avis
   * légal sur les ROMs.
   *
   * Un composant plutôt que deux blocs de markup, parce que l'accueil a DEUX
   * branches - la page d'atterrissage de quelqu'un qui n'est pas connecté, et
   * la bibliothèque de quelqu'un qui l'est - et que celui qui hésite encore à
   * se connecter est précisément celui qui a le plus besoin de lire ce que le
   * service fait de ses fichiers. Deux copies auraient divergé.
   *
   * `legalText` existait dans les deux langues depuis le début du projet et
   * n'était affiché nulle part : une phrase écrite, traduite, et jamais lue.
   * C'est ici qu'elle vit maintenant, avec le lien vers la page qui la
   * développe.
   */
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
</script>

<footer class="site-footer">
  <nav>
    <a href="/docs">{t($language, 'documentation')}</a>
  </nav>
  <p>{t($language, 'legalText')}</p>
</footer>

<style>
  .site-footer {
    /* Bornée et centrée comme le reste des colonnes de texte du site : une
       phrase de quatre lignes sur toute la largeur d'un écran 27 pouces ne se
       lit pas. */
    width: 100%;
    max-width: 60rem;
    margin: 0 auto;
    padding: 2rem 1.5rem 2.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.07);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  nav {
    display: flex;
    gap: 1.25rem;
    flex-wrap: wrap;
  }

  a {
    color: #8fa4ff;
    text-decoration: none;
    font-size: 0.95rem;
  }

  a:hover,
  a:focus-visible {
    text-decoration: underline;
  }

  p {
    margin: 0;
    /* Plus discret que le corps de texte, sans descendre au gris qui ne se
       lit plus : c'est un avis, il doit rester lisible. */
    color: #8a8a96;
    font-size: 0.85rem;
    line-height: 1.6;
    max-width: 46rem;
  }
</style>
