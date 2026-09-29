<!--
  B. La chambre de gamer, en pixels de SNES : papier peint à rayures violet
  nuit, fenêtre sur une ville, affiche HI-SCORE, fanion 1UP, et dans le coin
  la télé cathodique sur son meuble. Tout est dessiné par `pixel-art.ts`,
  à l'échelle entière, bords nets.
-->
<script lang="ts">
  import { SCALE, cartStack, crtCorner, nightWindow, playerPennant, scorePoster, wallTile } from '$lib/bedroom/pixel-art';

  // Un fond CSS répété plutôt qu'un motif SVG : le navigateur le peint une
  // fois, et la couche se déplace sans repeindre.
  const paper = `url("data:image/svg+xml,${encodeURIComponent(wallTile())}")`;
  const tile = `${16 * SCALE}px`;
</script>

<div class="layer" data-depth="0.12">
  <div class="fill" style="background: {paper} 0 0 / {tile} {tile} repeat"></div>
  <!-- La plinthe, au pied du mur : au bas de la bibliothèque. -->
  <div class="skirting"></div>
</div>

<div class="layer" data-depth="0.4">
  <div class="item px window">{@html nightWindow()}</div>
  <div class="item px poster">{@html scorePoster()}</div>
  <div class="item px pennant">{@html playerPennant()}</div>
</div>

<div class="layer" data-depth="0.85">
  <div class="item px crt">{@html crtCorner()}</div>
  <div class="item px carts">{@html cartStack()}</div>
  <!-- La lueur de la télé sur le mur, le seul flou de ce mur. -->
  <div class="item tv-glow"></div>
</div>

<style>
  /* Taille intrinsèque, multiple de 4 : jamais un pixel à 3,7 px. */
  .px :global(svg) {
    width: auto !important;
    image-rendering: pixelated;
  }

  .skirting {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 24px;
    height: 44px;
    background:
      linear-gradient(#8a6239 0 4px, #6b4a2b 4px 36px, #4a3019 36px 40px, #1a1430 40px);
  }

  .window {
    top: calc(24px + 88px);
    right: calc(24px + 2cqw);
  }

  .poster {
    top: calc(24px + var(--room) * 0.44);
    left: calc(24px + 1.5cqw);
    transform: rotate(-3deg);
  }

  .pennant {
    top: calc(24px + var(--room) * 0.3);
    left: calc(24px + 1cqw);
    transform: rotate(6deg);
  }

  /* Trois pixels d'écran par pixel : la télé tient dans la marge d'un
     écran de 1440 au lieu de passer derrière les jaquettes. */
  .crt :global(svg) {
    zoom: 0.75;
  }

  .crt {
    right: calc(24px + 4px);
    bottom: calc(24px + 12px);
  }

  .carts {
    left: calc(24px + 1cqw);
    bottom: calc(24px + 36px);
  }

  .tv-glow {
    right: calc(24px + 1cqw - 30px);
    bottom: calc(24px + 70px);
    width: 220px;
    height: 180px;
    border-radius: 50%;
    background: radial-gradient(closest-side, rgba(63, 208, 201, 0.22), rgba(63, 208, 201, 0));
  }

  /* Sur un téléphone, la moitié de la taille : les mêmes pixels, par deux. */
  @container (max-width: 768px) {
    .px :global(svg) { zoom: 0.5; }
    .window { top: calc(24px + 70px); right: calc(24px + 8px); }
    .poster { top: calc(24px + var(--room) * 0.52); left: calc(24px + 4px); }
    .pennant { top: calc(24px + var(--room) * 0.34); left: calc(24px + 2px); }
    .crt :global(svg) { zoom: 0.5; }
    .crt { right: calc(24px + 4px); }
    .carts { left: calc(24px + 4px); }
    .tv-glow { width: 120px; height: 100px; right: calc(24px - 10px); bottom: calc(24px + 30px); }
  }
</style>
