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
import type { ScreenPlacement } from './layout';
import type { VideoSurface } from '$lib/znet/core';

export interface VrScreen {
  mesh: THREE.Mesh;
  upload(surface: VideoSurface): void;
  showTestPattern(): void;
  dispose(): void;
}

export function createVrScreen(placement: ScreenPlacement): VrScreen {
  const material = new THREE.MeshBasicMaterial({
    // The SNES palette is already the picture; three's tone mapping would
    // crush it toward grey.
    toneMapped: false
  });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.position.set(0, placement.centerY, 0);

  let texture: THREE.DataTexture | null = null;
  /** Rebuilt only when the picture's shape changes - a mode switch, not a
   * frame. */
  let builtFor = { width: -1, height: -1, stride: -1 };

  function rebuild(width: number, height: number, stride: number): void {
    mesh.geometry.dispose();
    const { positions, uvs, indices } = curvedScreenGeometry({
      radius: placement.radius,
      arc: placement.arc,
      height: placement.height,
      uMax: visibleU(width, stride)
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    mesh.geometry = geometry;

    texture?.dispose();
    texture = new THREE.DataTexture(
      new Uint8Array(stride * height * 4),
      stride,
      height,
      THREE.RGBAFormat
    );
    // Nearest both ways: this is a 256-wide picture on a two-metre screen, and
    // smoothing it is the opposite of what anyone came for. No mipmaps either
    // - the screen never recedes, so they would be generated and never read.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    // The core's first row is the top of the frame; a DataTexture's is the
    // bottom. Flipping here is the same single reversal `webgl-renderer.ts`
    // does with its two quads.
    texture.flipY = true;
    material.map = texture;
    material.needsUpdate = true;

    builtFor = { width, height, stride };
  }

  return {
    mesh,

    upload(surface: VideoSurface): void {
      if (
        surface.width !== builtFor.width ||
        surface.height !== builtFor.height ||
        surface.stride !== builtFor.stride
      ) {
        rebuild(surface.width, surface.height, surface.stride);
      }
      /*
       * The view is handed to the texture rather than copied into it, which is
       * the whole point of `videoSurface()`. Its header warns the view "is only
       * valid until the next core call - anything that can grow the heap
       * invalidates it. Upload it and forget it." That is satisfied here: the
       * assignment and the upload both happen inside this frame, before the
       * core runs again.
       */
      texture!.image.data = surface.data as unknown as Uint8Array;
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
      rebuild(width, height, stride);
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

    dispose(): void {
      mesh.geometry.dispose();
      texture?.dispose();
      material.dispose();
    }
  };
}
