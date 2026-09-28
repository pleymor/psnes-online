<script lang="ts">
  /**
   * L'aperçu d'un fond : le mur lui-même, dessiné sur une scène d'écran
   * d'ordinateur puis réduit à la taille de la vignette. Pour « Aléatoire »,
   * les quatre murs en mosaïque, puisque c'est l'un d'eux qu'on aura.
   *
   * Réduit par `transform` et non redessiné petit : les motifs, les pixels
   * du mur B et les placements gardent leurs proportions, et la vignette
   * montre exactement ce que la bibliothèque montrera.
   */
  import BedroomWall from './BedroomWall.svelte';
  import { WALLPAPERS, type WallpaperChoice } from '$lib/stores/wallpaper-preference';

  export let choice: WallpaperChoice;

  /** La scène : un écran de 1280 x 800, celui où les murs ont été composés. */
  const STAGE_W = 1280;
  const STAGE_H = 800;

  let width = 0;
  $: walls = choice === 'random' ? WALLPAPERS : [choice];
  $: cell = choice === 'random' ? width / 2 : width;
  $: scale = cell / STAGE_W;
</script>

<div class="thumb" class:mosaic={choice === 'random'} bind:clientWidth={width}>
  {#if width > 0}
    {#each walls as variant (variant)}
      <div class="cell">
        <div class="stage" style="width: {STAGE_W}px; height: {STAGE_H}px; transform: scale({scale});">
          <BedroomWall {variant} thumbnail />
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .thumb {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 10;
    overflow: hidden;
    border-radius: 6px;
    background: #000;
    display: grid;
  }

  .mosaic {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 1px;
  }

  .cell {
    position: relative;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
  }

  .stage {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
  }
</style>
