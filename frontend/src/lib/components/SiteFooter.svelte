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
   *
   * La mise en page tient en deux étages, et c'est délibéré : une ligne de
   * pied de page - la marque à gauche, la navigation à droite - puis l'avis
   * en dessous. Avant, l'avis était seul : quatre lignes de gris alignées à
   * gauche sous un accueil entièrement centré, ce qui donnait au bloc l'air
   * d'un collage. La ligne du haut tient les deux bords, donc le bloc est
   * ancré, et l'avis n'est plus la seule chose à lire ici.
   */
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
</script>

<footer class="site-footer">
  <div class="bar">
    <span class="wordmark">psnes</span>
    <nav>
      <a href="/docs">{t($language, 'documentation')}</a>
    </nav>
  </div>
  <p class="notice">{t($language, 'legalText')}</p>
</footer>

<style>
  .site-footer {
    /* Bornée et centrée comme le reste des colonnes de texte du site - c'est
       la largeur de `/docs`, la page où ce lien mène : une phrase de quatre
       lignes sur toute la largeur d'un écran 27 pouces ne se lit pas. */
    width: 100%;
    max-width: 60rem;
    margin: 0 auto;
    padding: 0 1.5rem 3rem;
  }

  /* Le filet, en dégradé qui s'éteint aux deux bouts plutôt qu'en trait net.
     Un trait franc de 60rem sous une colonne centrée de 600px fait se
     rencontrer deux largeurs sans rapport ; en s'effaçant, il sépare sans
     annoncer une largeur. Un ::before plutôt qu'un border-top pour la même
     raison qu'il porte sa marge : il vit dans le flux, donc l'espace
     au-dessus et en dessous se règle ici, en un seul endroit. */
  .site-footer::before {
    content: '';
    display: block;
    height: 1px;
    margin: 0 0 1.75rem;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(255, 255, 255, 0.13) 15%,
      rgba(255, 255, 255, 0.13) 85%,
      transparent
    );
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem 1.25rem;
  }

  .wordmark {
    /* Le dégradé du titre de l'accueil et de celui de `/docs`, en petit : ce
       qui signe le bas de page appartient à la même famille que ce qui signe
       le haut. */
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  nav {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* La pastille du sommaire de `/docs`, à l'identique. C'était un lien bleu
     souligné au survol, la seule occurrence de ce style sur le site. */
  a {
    padding: 0.35rem 0.85rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    color: #c8c8d0;
    text-decoration: none;
    font-size: 0.9rem;
    transition: border-color 0.15s, background 0.15s, color 0.15s;
  }

  a:hover,
  a:focus-visible {
    border-color: rgba(102, 126, 234, 0.8);
    background: rgba(102, 126, 234, 0.12);
    color: #fff;
  }

  .notice {
    margin: 1.5rem 0 0;
    /* Le filet à gauche dit « petite ligne » sans rien retirer à la lecture.
       La taille et la couleur ne bougent pas d'un cheveu par rapport à
       avant : c'est un avis légal, il doit rester lisible, donc il est
       rétrogradé par sa place et son cadre, jamais en le rendant plus pâle
       ou plus petit. */
    padding-left: 0.9rem;
    border-left: 2px solid rgba(102, 126, 234, 0.3);
    color: #8a8a96;
    font-size: 0.85rem;
    line-height: 1.6;
    max-width: 46rem;
  }

  @media (max-width: 40rem) {
    .site-footer {
      padding: 0 1rem 2.5rem;
    }

    .bar {
      /* La marque et le lien l'un sous l'autre : à deux bords si proches,
         `space-between` ne tient plus rien, il écarte juste deux objets de
         quelques pixels. */
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
