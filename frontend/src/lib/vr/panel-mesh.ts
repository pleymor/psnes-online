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
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

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
