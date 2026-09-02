/**
 * The coordinate model every VR panel shares.
 *
 * A panel is a canvas drawn by hand plus a list of rectangles, because an
 * immersive session has no DOM to reuse. Pointing at one reduces entirely to
 * this module: three.js reports a `uv` on the mesh, and this says which
 * rectangle it is.
 *
 * It owns no canvas, no texture and no three import, and that is the point.
 * Panel layout is therefore a pure function returning `Region[]`, testable
 * under Bun; only the `fillText` calls that consume those regions are not.
 * `scene.ts` owns the canvases and the textures.
 */

export interface Region {
  /** What the panel's click handler switches on. Stable across redraws. */
  id: string;
  /** Canvas pixels, top-left origin. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

export interface Uv {
  x: number;
  y: number;
}

/**
 * A mesh `uv` in canvas pixels.
 *
 * The v flip is the only interesting line in this file, and it is the same
 * reversal `znet/webgl-renderer.ts` reasons about at length: a plane's uv has
 * v = 0 at the bottom, a canvas has y = 0 at the top, so the axis is reversed
 * exactly once - here, and nowhere else.
 */
export function uvToCanvas(uv: Uv, size: PanelSize): { x: number; y: number } {
  return { x: uv.x * size.width, y: (1 - uv.y) * size.height };
}

/**
 * Which region a raycast landed on, or null.
 *
 * A uv outside the unit square returns null rather than being clamped: a ray
 * that missed the mesh must not be reported as a press on its nearest edge.
 *
 * The first match wins, so the caller's array order is its z-order.
 */
export function hit(
  regions: readonly Region[],
  uv: Uv,
  size: PanelSize
): Region | null {
  if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return null;

  const { x, y } = uvToCanvas(uv, size);
  for (const region of regions) {
    if (
      x >= region.x &&
      x <= region.x + region.w &&
      y >= region.y &&
      y <= region.y + region.h
    ) {
      return region;
    }
  }
  return null;
}
