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
   */
  import { parallax } from '$lib/bedroom/parallax';
  import type { Wall } from '$lib/bedroom/choice';
  import WallA from './walls/WallA.svelte';
  import WallB from './walls/WallB.svelte';
  import WallC from './walls/WallC.svelte';
  import WallD from './walls/WallD.svelte';

  export let variant: Exclude<Wall, 'current'>;
  /** Tout arrêter : une partie tourne, ou une fiche couvre le mur. */
  export let paused = false;

  const WALLS = { a: WallA, b: WallB, c: WallC, d: WallD };
</script>

<!-- `{#key}` : un autre mur, d'autres calques, que l'action doit relire. -->
{#key variant}
  <div class="wall" aria-hidden="true" use:parallax={{ paused }}>
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
    /* Rien de ce qui se passe ici ne touche la mise en page du reste. */
    contain: strict;
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
