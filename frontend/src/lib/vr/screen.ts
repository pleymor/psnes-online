/**
 * The curved screen, and the one upload per frame that feeds it.
 *
 * The texture is `stride` pixels wide, not `width`: the mesh's u stops at
 * `width / stride` (see `screen-geometry.ts`), so the padded half of every row
 * is uploaded and never sampled. That trades a little VRAM for no per-frame
 * copy at all, which is the right way round - `videoFrame()`'s repack is
 * 230 KB of memmove sixty times a second.
 *
 * Nothing here drives anything. `scene.ts` renders when the XR loop says so
 * and `FrameGovernor` decides when a frame exists, which is the rule
 * `znet/webgl-renderer.ts:8` states in capitals for the flat path.
 */

import * as THREE from 'three';
import { curvedScreenGeometry, visibleU } from './screen-geometry';
import {
  pictureUniforms,
  PICTURE_VERTEX_SHADER,
  PICTURE_FRAGMENT_SHADER
} from './picture-filter';
import type { ScreenPlacement } from './layout';
import type { VideoSurface } from '$lib/znet/core';
import type { PanelSize, Region } from './panel';

export interface VrScreen {
  mesh: THREE.Mesh;
  upload(surface: VideoSurface): void;
  showTestPattern(): void;
  /**
   * Turns the screen into a canvas and paints it.
   *
   * The paint and the upload are one call for the reason `panel-mesh.ts`
   * gives about its own: a forgotten `needsUpdate` leaves a panel correct in
   * memory and stale on the player's face, which is the most confusing way
   * this shape can fail.
   */
  paintPanel(size: PanelSize, draw: (ctx: CanvasRenderingContext2D) => void): void;
  /**
   * Gives the screen back to the emulator.
   *
   * Explicit, because the alternative was a race the emulator won: see
   * `upload`.
   */
  showPicture(): void;
  isPanel(): boolean;
  panelSize(): PanelSize | null;
  /** Replaced whenever the launch screen is laid out. `scene.aimedAt` reads it. */
  regions: Region[];
  dispose(): void;
}

/**
 * The texture behind a screen-sized panel, configured once for both callers.
 *
 * Linear both ways and no mipmaps. Nearest is wrong here - this is text and
 * box art on a two-and-a-half-metre screen, and nearest-neighbour text at an
 * angle is unreadable - but so is trilinear, for the reason `panel-mesh.ts`
 * sets out at length: mipmaps were added against a shimmer whose real cause
 * was an aliased canvas, and once that was fixed at source they only softened
 * the text. The picture next door gets the pixel-art filter instead, which is
 * a different problem with a different answer (`picture-filter.ts`).
 */
function panelTextureFor(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

export function createVrScreen(placement: ScreenPlacement): VrScreen {
  /*
   * Two materials now, swapped on the mesh, where there used to be one with
   * its `map` reassigned.
   *
   * They want genuinely different filtering and can no longer share. The
   * picture needs the pixel-art filter in `picture-filter.ts`, which is a
   * shader; a launch screen is text and box art and wants three's ordinary
   * bilinear path with the mipmaps `panelTextureFor` sets up. Trying to serve
   * both from one material is what forced the picture to choose between
   * nearest and blur in the first place.
   */
  const pictureMaterial = new THREE.ShaderMaterial({
    vertexShader: PICTURE_VERTEX_SHADER,
    fragmentShader: PICTURE_FRAGMENT_SHADER,
    // Replaced wholesale by `rebuildPicture`; these are only shapes so the
    // uniforms exist before the first frame.
    uniforms: {
      map: { value: null },
      texSize: { value: new THREE.Vector2(1, 1) },
      uMax: { value: 1 }
    }
  });
  const panelMaterial = new THREE.MeshBasicMaterial({
    // The SNES palette is already the picture; three's tone mapping would
    // crush it toward grey. The picture's shader says the same thing by
    // leaving `tonemapping_fragment` out.
    toneMapped: false
  });
  // The material parameter is widened on purpose: it is inferred from the
  // constructor argument, so without this the mesh is typed as taking only a
  // `ShaderMaterial` and swapping in the panel's is a type error.
  const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
    new THREE.BufferGeometry(),
    pictureMaterial
  );
  mesh.position.set(0, placement.centerY, 0);

  let texture: THREE.DataTexture | null = null;
  /** Rebuilt only when the picture's shape changes - a mode switch, not a
   * frame. */
  let builtFor = { width: -1, height: -1, stride: -1 };

  let panelCanvas: HTMLCanvasElement | null = null;
  let panelCtx: CanvasRenderingContext2D | null = null;
  let panelTexture: THREE.CanvasTexture | null = null;
  let panelAt: PanelSize | null = null;
  /** Which of the two things this screen currently is. */
  let mode: 'picture' | 'panel' = 'picture';
  /** Replaced whenever the launch screen is laid out. `scene.aimedAt` reads it. */
  const regions: Region[] = [];

  function rebuildGeometry(uMax: number): void {
    mesh.geometry.dispose();
    const { positions, uvs, indices } = curvedScreenGeometry({
      radius: placement.radius,
      arc: placement.arc,
      height: placement.height,
      uMax
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    mesh.geometry = geometry;
  }

  function rebuildPicture(width: number, height: number, stride: number): void {
    rebuildGeometry(visibleU(width, stride));

    texture?.dispose();
    texture = new THREE.DataTexture(
      new Uint8Array(stride * height * 4),
      stride,
      height,
      THREE.RGBAFormat
    );
    /*
     * LINEAR, where this said nearest for the whole of the project's life.
     *
     * The old comment was "smoothing it is the opposite of what anyone came
     * for", and that is still true - this is not smoothing. The filter in
     * `picture-filter.ts` computes a sample coordinate that sits exactly on a
     * texel centre everywhere except within one display pixel of a texel
     * boundary, and it needs the hardware's bilinear tap to do the blending
     * across that boundary. Left on `NearestFilter` the GPU would snap the
     * coordinate straight back to a centre, the shader would compute its
     * sub-texel offsets for nothing, and the picture would boil exactly as
     * before. These two lines are what make the shader mean anything.
     *
     * Still no mipmaps: the screen never recedes, so they would be generated
     * and never read.
     */
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    // The core's first row is the top of the frame; a DataTexture's is the
    // bottom. Flipping here is the same single reversal `webgl-renderer.ts`
    // does with its two quads.
    texture.flipY = true;

    // The shader indexes the padded texture and stops at `uMax`; both come
    // from one place so they cannot disagree.
    const { texSize, uMax } = pictureUniforms(width, height, stride);
    pictureMaterial.uniforms.map.value = texture;
    pictureMaterial.uniforms.texSize.value.set(texSize[0], texSize[1]);
    pictureMaterial.uniforms.uMax.value = uMax;
    mesh.material = pictureMaterial;

    builtFor = { width, height, stride };
    mode = 'picture';
  }

  return {
    mesh,

    upload(surface: VideoSurface): void {
      /*
       * A running game does not take the screen back by itself.
       *
       * The mode is authoritative, and it has to be. A game is still running
       * while its player recalls the panels and opens another game's launch
       * screen - `resume` exists precisely so they can go back to it - and its
       * `onFrame` keeps calling this method seventy-two times a second. When
       * this method could switch the mode, it won: the launch screen appeared
       * for exactly one frame, the emulator's picture reclaimed the screen,
       * `isPanel()` went false, and the screen dropped out of `aimedAt`'s
       * targets - so `launch` and the save rows could never be pressed again,
       * and the staged game was unreachable for the rest of the session.
       *
       * The frames are dropped, not queued: the emulator, its audio and its
       * cartridge save all keep running, and only the picture waits. That is
       * what a menu over a running game should do.
       */
      if (mode === 'panel') return;

      if (
        surface.width !== builtFor.width ||
        surface.height !== builtFor.height ||
        surface.stride !== builtFor.stride
      ) {
        rebuildPicture(surface.width, surface.height, surface.stride);
      }
      /*
       * The view is handed to the texture rather than copied into it, which is
       * the whole point of `videoSurface()`. Its header warns the view "is only
       * valid until the next core call - anything that can grow the heap
       * invalidates it. Upload it and forget it." That is satisfied here: the
       * assignment and the upload both happen inside this frame, before the
       * core runs again.
       */
      texture!.image.data = surface.data;
      texture!.needsUpdate = true;
    },

    /**
     * A picture with no emulator behind it.
     *
     * It exists so the geometry, distance, height and aspect can be judged
     * before a ROM is involved. A screen that is too low is obvious against a
     * grid and invisible against Super Mario World.
     */
    showTestPattern(): void {
      const width = 256;
      const height = 224;
      const stride = 512;
      rebuildPicture(width, height, stride);
      const data = texture!.image.data as Uint8Array;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < stride; x++) {
          const i = (y * stride + x) * 4;
          const inPadding = x >= width;
          const cell = ((x >> 4) + (y >> 4)) & 1;
          // The padding is filled magenta on purpose: if any of it is visible,
          // uMax is wrong, and it will be unmistakable rather than subtle.
          data[i] = inPadding ? 255 : cell ? 220 : 30;
          data[i + 1] = inPadding ? 0 : cell ? 220 : 30;
          data[i + 2] = inPadding ? 255 : cell ? 220 : 30;
          data[i + 3] = 255;
        }
      }
      texture!.needsUpdate = true;
    },

    /**
     * Turns the screen into a canvas and paints it.
     *
     * The paint and the upload are one call for the reason `panel-mesh.ts`
     * gives about its own: a forgotten `needsUpdate` leaves a panel correct in
     * memory and stale on the player's face, which is the most confusing way
     * this shape can fail.
     */
    paintPanel(size: PanelSize, draw: (ctx: CanvasRenderingContext2D) => void): void {
      if (!panelCanvas) {
        panelCanvas = document.createElement('canvas');
        panelCanvas.width = size.width;
        panelCanvas.height = size.height;
        panelCtx = panelCanvas.getContext('2d');
        if (!panelCtx) throw new Error('no 2d context for the screen panel');
        panelTexture = panelTextureFor(panelCanvas);
        panelAt = size;
      } else if (panelAt && (panelAt.width !== size.width || panelAt.height !== size.height)) {
        /*
         * A second size, honoured rather than ignored.
         *
         * The canvas is created once, so a later call with different
         * dimensions used to keep the old ones - and `panelSize()`, which is
         * what `scene.aimedAt` hit-tests against, would then report a size the
         * canvas no longer had: every press landing on the wrong region, with
         * the picture looking perfectly correct. Unreachable while the only
         * caller passes one constant, which is exactly the kind of latent
         * branch this project keeps discovering inside a headset.
         */
        panelCanvas.width = size.width;
        panelCanvas.height = size.height;
        panelAt = size;
        // The canvas element is the texture's source; resizing it blanks the
        // pixels, so three has to be told the source changed shape.
        panelTexture!.dispose();
        panelTexture = panelTextureFor(panelCanvas);
        panelMaterial.map = panelTexture;
        panelMaterial.needsUpdate = true;
      }

      if (mode !== 'panel') {
        // uMax 1, not the picture's width/stride: the game's geometry stops
        // half way across the texture, and reusing it would show the player
        // the left half of a launch screen with no clue why.
        rebuildGeometry(1);
        panelMaterial.map = panelTexture;
        panelMaterial.needsUpdate = true;
        mesh.material = panelMaterial;
        mode = 'panel';
      }

      draw(panelCtx!);
      panelTexture!.needsUpdate = true;
    },

    /*
     * The one way out of panel mode, and the reason it is a method.
     *
     * `builtFor` is forgotten here rather than when the panel went up. The
     * shape has to be invalidated - otherwise the next frame finds it
     * unchanged, skips the rebuild, and uploads a picture into geometry built
     * for a 1024x768 canvas at full uv. But invalidating it at paint time made
     * `upload` rebuild on its very next call, which is how the emulator used
     * to steal the screen back. Doing it here means the caller decides when
     * the picture returns.
     */
    showPicture(): void {
      if (mode === 'picture') return;
      builtFor = { width: -1, height: -1, stride: -1 };
      mode = 'picture';
    },

    isPanel: () => mode === 'panel',
    panelSize: () => panelAt,
    regions,

    dispose(): void {
      mesh.geometry.dispose();
      texture?.dispose();
      panelTexture?.dispose();
      pictureMaterial.dispose();
      panelMaterial.dispose();
    }
  };
}
