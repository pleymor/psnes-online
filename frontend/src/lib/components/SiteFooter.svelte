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
    /* Bornée comme le reste des colonnes de texte du site - une phrase de
       quatre lignes sur toute la largeur d'un écran 27 pouces ne se lit pas -
       mais alignée à gauche et non centrée : sous une grille pleine largeur,
       un bloc centré à 60rem flottait sans rapport avec ce qui le précédait.
       Le compromis était signalé le matin même ; la reprise de la
       bibliothèque l'a rendu visible. */
    width: 100%;
    max-width: 60rem;
    margin: 2.5rem 0 3rem;
    padding: 1.25rem 1.25rem 1.5rem;
    background: var(--panel);
    border: 3px solid var(--edge);
    border-radius: 9px;
  }

  /* Le filet dégradé a disparu avec ce qu'il séparait. Il existait parce
     que le pied de page n'avait pas de bord à lui et flottait sur le même
     noir que la page ; maintenant qu'il est une plaque cernée d'or, se
     dessiner un second trait à l'intérieur serait redire la même chose.
     La plaque plutôt qu'un bandeau pleine largeur : le pied de page vit à
     l'intérieur du `<main>` sur la bibliothèque et à la racine sur la page
     de connexion, donc un bandeau demanderait des marges négatives qui
     déborderaient sur la seconde. */

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem 1.25rem;
  }

  /* Silkscreen et non un dégradé : le bas de page signe avec la même
     écriture que les tuiles, et le dégradé violet était le tell générique
     que la reprise a chassé partout ailleurs. */
  .wordmark {
    font-family: 'Silkscreen', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    color: var(--shell);
  }

  nav {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* La pastille du sommaire de `/docs`, à l'identique. C'était un lien bleu
     souligné au survol, la seule occurrence de ce style sur le site. */
  a {
    padding: 0.3rem 0.8rem;
    border: 2px solid var(--edge);
    border-radius: 6px;
    color: var(--shell);
    text-decoration: none;
    font-family: var(--display);
    font-size: 1.05rem;
    transition: background 0.15s, color 0.15s;
  }

  a:hover,
  a:focus-visible {
    background: var(--edge);
    color: var(--panel);
  }

  @media (prefers-reduced-motion: reduce) {
    a {
      transition: none;
    }
  }

  .notice {
    margin: 1.5rem 0 0;
    /* Le filet à gauche dit « petite ligne » sans rien retirer à la lecture.
       La taille et la couleur ne bougent pas d'un cheveu par rapport à
       avant : c'est un avis légal, il doit rester lisible, donc il est
       rétrogradé par sa place et son cadre, jamais en le rendant plus pâle
       ou plus petit. */
    padding-left: 0.9rem;
    border-left: 2px solid var(--edge);
    color: var(--ridge);
    font-size: 0.85rem;
    line-height: 1.6;
    max-width: 46rem;
  }

  @media (max-width: 40rem) {
    .site-footer {
      padding: 1rem 1rem 1.25rem;
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
