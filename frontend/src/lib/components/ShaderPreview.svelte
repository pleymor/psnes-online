<script lang="ts">
  /**
   * One shader, shown rather than named.
   *
   * Choosing between "xBRZ", "sharp bilinear" and "FXAA" from their names is a
   * guess unless you already know what they do. This runs the real preset over
   * a generated test pattern through the same pipeline the game uses, so the
   * choice is made by looking.
   *
   * Two canvases for the same reason the rooms have two: a canvas binds one
   * context type for life, so the no-shader case cannot share the WebGL one.
   */
  import { onDestroy, onMount } from 'svelte';
  import { WebglRenderer, loadShaderPreset } from '$lib/znet';
  import { previewSurface } from '$lib/znet/preview-pattern';
  import { createLogger } from '$lib/utils/logger';

  export let shaderId: string;

  const logger = createLogger('ShaderPreview');

  let canvas2d: HTMLCanvasElement;
  let canvasGl: HTMLCanvasElement;
  let renderer: WebglRenderer | null = null;
  let usingGl = false;
  /** Set when the preset could not be loaded or compiled - the plain pattern
   *  is shown instead, which is honest: that is what the game would show. */
  let fellBack = false;
  let destroyed = false;

  const surface = previewSurface();

  function drawPlain(): void {
    const context = canvas2d.getContext('2d');
    if (!context) return;
    canvas2d.width = surface.width;
    canvas2d.height = surface.height;
    // The surface is tightly packed here (stride === width), so one copy into
    // a clamped array is the whole conversion - no row-by-row work.
    const pixels = new Uint8ClampedArray(
      surface.data.subarray(0, surface.width * surface.height * 4)
    );
    context.putImageData(new ImageData(pixels, surface.width, surface.height), 0, 0);
  }

  onMount(async () => {
    if (!shaderId) {
      drawPlain();
      return;
    }

    const loaded = await loadShaderPreset(shaderId);
    if (destroyed) return;

    if (!loaded.ok) {
      logger.warn('preview preset unavailable', { shaderId, reason: loaded.reason });
      fellBack = true;
      drawPlain();
      return;
    }

    const webgl = WebglRenderer.create(canvasGl, loaded.preset);
    if (!webgl) {
      logger.warn('preview needs webgl2', { shaderId });
      fellBack = true;
      drawPlain();
      return;
    }

    renderer = webgl;
    usingGl = true;
    renderer.drawSurface(surface);
  });

  onDestroy(() => {
    destroyed = true;
    // One GL context per preview, so releasing them matters more here than in
    // a room: a page of previews would otherwise sit near the browser's cap.
    renderer?.dispose();
    renderer = null;
  });
</script>

<div class="preview">
  <canvas bind:this={canvas2d} class:hidden={usingGl}></canvas>
  <canvas bind:this={canvasGl} class:hidden={!usingGl}></canvas>
  {#if fellBack}
    <!-- Otherwise a shader that failed to load would be indistinguishable
         from "no shader" in a side-by-side comparison. -->
    <span class="failed" title="This shader could not be loaded">!</span>
  {/if}
</div>

<style>
  .preview {
    position: relative;
    width: 100%;
    aspect-ratio: 8 / 7;
    background: #000;
    border-radius: 6px;
    overflow: hidden;
  }

  canvas {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
    image-rendering: pixelated;
  }

  .hidden {
    display: none;
  }

  .failed {
    position: absolute;
    top: 0.25rem;
    right: 0.35rem;
    font-weight: 700;
    color: #f87171;
  }
</style>
