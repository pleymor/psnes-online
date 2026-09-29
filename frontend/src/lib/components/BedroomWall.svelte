<script lang="ts">
  /**
   * Le mur de la chambre, derrière la bibliothèque.
   *
   * Fixé à la fenêtre, pas à la page : les étagères défilent devant un mur
   * qui reste, et c'est déjà là la moitié de la profondeur. L'autre moitié est
   * `parallax.ts`, qui fait glisser les calques de quelques pixels.
   *
   * Monté par la seule page de la bibliothèque. Le salon et l'écran de jeu ne
   * le connaissent pas : l'émulateur ne peut pas perdre une frame à cause
   * d'un papier peint qui n'est pas dans son document.
   *
   * `thumbnail` : le même mur, immobile et posé dans sa boîte plutôt que sur
   * la fenêtre, pour l'aperçu du profil. Les murs se mesurent à leur boîte
   * (`cqw`, `cqh`, `@container`) et non à l'écran, donc l'aperçu est le mur,
   * en petit, et pas une capture.
   */
  import { parallax, type ParallaxOptions } from '$lib/bedroom/parallax';
  import type { Wallpaper } from '$lib/stores/wallpaper-preference';
  import WallA from './walls/WallA.svelte';
  import WallB from './walls/WallB.svelte';
  import WallC from './walls/WallC.svelte';
  import WallD from './walls/WallD.svelte';

  export let variant: Wallpaper;
  /** Tout arrêter : une partie tourne, ou une fiche couvre le mur. */
  export let paused = false;
  /** L'interrupteur « Effet de profondeur » du profil. Coupé, le mur reste, immobile. */
  export let depth = true;
  export let thumbnail = false;

  const WALLS = { nineties: WallA, gamer: WallB, pastel: WallC, blue: WallD };

  /** Un aperçu n'écoute rien et ne bouge pas : pas d'action du tout. */
  function motion(node: HTMLElement, options: ParallaxOptions & { still: boolean }) {
    return options.still ? {} : parallax(node, options);
  }
</script>

<!-- `{#key}` : un autre mur, d'autres calques, que l'action doit relire. -->
{#key variant}
  <div class="wall" class:thumbnail data-wall={variant} aria-hidden="true" use:motion={{ paused, enabled: depth, still: thumbnail }}>
    <svelte:component this={WALLS[variant]} />
  </div>
{/key}

<style>
  .wall {
    position: fixed;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    pointer-events: none;
    /* Rien de ce qui se passe ici ne touche la mise en page du reste, et les
       murs se placent en unités de cette boîte. */
    contain: strict;
    container: wall / size;
  }

  .wall.thumbnail {
    position: absolute;
  }

  /*
   * Un calque déborde de 24 px de chaque côté : glissé de 18 au plus, il ne
   * montre jamais son bord. `will-change` le met sur sa propre couche, que le
   * compositeur déplace sans rien repeindre.
   */
  .wall :global(.layer) {
    position: absolute;
    inset: -24px;
    will-change: transform;
  }

  .wall.thumbnail :global(.layer) {
    will-change: auto;
  }

  .wall :global(.fill) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  /* Sans `display` : absolu, un objet est déjà un bloc, et chaque mur doit
     pouvoir en cacher un sur téléphone sans lutter de spécificité. */
  .wall :global(.item) {
    position: absolute;
  }

  .wall :global(.item svg) {
    display: block;
    width: 100%;
    height: auto;
  }
</style>
