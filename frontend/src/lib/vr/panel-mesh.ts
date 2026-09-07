/**
 * One panel: a canvas, its texture, and the quad it lives on.
 *
 * Redrawing goes through `paint`, which marks the texture dirty afterwards.
 * That is not ceremony - a forgotten `needsUpdate` produces a panel that is
 * correct in memory and stale on the player's face, which is the single most
 * confusing bug this shape can have. Making the upload part of the call means
 * it cannot be skipped.
 *
 * A panel redraws only when its data or its hover changes, never per frame.
 * Three panels re-rasterised at 72 Hz would cost more than the emulator does.
 */

import * as THREE from 'three';
import type { Placement } from './layout';
import type { PanelSize, Region } from './panel';

export interface PanelMesh {
  id: string;
  mesh: THREE.Mesh;
  size: PanelSize;
  ctx: CanvasRenderingContext2D;
  /** Replaced whenever the layout is recomputed. `scene.raycast` reads it. */
  regions: Region[];
  paint(draw: (ctx: CanvasRenderingContext2D) => void): void;
  dispose(): void;
}

export function createPanelMesh(
  id: string,
  placement: Placement,
  size: PanelSize
): PanelMesh {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`no 2d context for the ${id} panel`);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Linear here, unlike the screen: this is text and box art, not a 256-wide
  // pixel picture, and nearest-neighbour text at an angle is unreadable.
  texture.magFilter = THREE.LinearFilter;
  /*
   * Mipmapped, because these panels are MINIFIED, which is not obvious and is
   * what made the covers shimmer.
   *
   * The lectern is 800 canvas pixels across 0.7 m at 1.2 m, which is 32.5
   * degrees, so it carries about 24.6 canvas pixels per degree against roughly
   * 20 the headset can show - and `layout.ts` tips it back 40 degrees, so
   * vertically the figure is nearer 1.6 canvas pixels per rendered pixel. A
   * plain `LinearFilter` answers that with ONE bilinear tap, which cannot see
   * the texels its footprint covers: it skips some, and which ones it skips
   * changes with every small movement of the head. That is the shimmer, and it
   * is minification aliasing rather than anything to do with sharpness.
   *
   * Trilinear alone would then over-blur a panel seen this obliquely, so the
   * anisotropy pays that back. The number is generous on purpose - three
   * clamps it to whatever the device actually supports
   * (`WebGLTextures.js:702`), which is why this file still needs no renderer.
   *
   * The cost is a `generateMipmap` per upload. Affordable for exactly the
   * reason in this file's header: a panel redraws when its data or its hover
   * changes, never per frame. The canvas is not a power of two, which is fine
   * - three has been WebGL2-only since r163 (`WebGLCapabilities.js:119`), and
   * WebGL2 mipmaps NPOT textures without complaint.
   */
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    toneMapped: false
  });

  // PlaneGeometry's own uv has v = 0 at the bottom, which is exactly what
  // `panel.hit()` expects and flips. Do not "fix" it here.
  const geometry = new THREE.PlaneGeometry(placement.width, placement.height);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...placement.position);
  /*
   * `YXZ`, not three's default `XYZ`, and this is not a preference.
   *
   * A lectern is aimed and then tipped back: swing it round to its azimuth,
   * then pitch it about its OWN horizontal axis. Under `XYZ` the pitch is
   * applied before the yaw carries it away, so the two combine into a roll -
   * measured at 33.8 degrees for these placements, and mirrored, so the left
   * panel leans one way and the right panel the other. Nothing in the design
   * asks for any roll at all.
   *
   * With `YXZ` the same numbers give exactly zero roll and a facing of
   * cos(40 deg) = 0.766, which is precisely the intended tip-back. The order
   * has to be set before the values, or `set()` uses the old one.
   */
  mesh.rotation.order = 'YXZ';
  mesh.rotation.set(...placement.rotation);

  return {
    id,
    mesh,
    size,
    ctx,
    regions: [],
    paint(draw) {
      draw(ctx);
      texture.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    }
  };
}
