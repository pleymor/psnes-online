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

/** A rectangle in canvas pixels with nothing to click on. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A source's own dimensions, taking `naturalWidth` over `width`.
 *
 * Two traps, and both of them are why this is a function with tests rather
 * than two property reads at the call site.
 *
 * `width` on an HTMLImageElement is its LAYOUT size, so an image carrying a
 * `width` attribute - or read before layout - reports something that is not
 * its intrinsic shape, and an aspect ratio computed from that is wrong in
 * exactly the way `fitContain` exists to fix. But `naturalWidth` is 0 until
 * `onload`, so it cannot simply win: it wins only when it is a usable number.
 *
 * And `CanvasImageSource` includes `SVGImageElement`, whose `width` is an
 * `SVGAnimatedLength` OBJECT rather than a number - svelte-check rejected the
 * first version of this function over precisely that. An object reaching the
 * aspect arithmetic would give a NaN rectangle, which draws nothing at all: a
 * cover that silently vanishes. So every field is checked for being a finite
 * number, and anything else reports no size, which `fitContain` answers by
 * filling the slot.
 *
 * An `ImageBitmap` or a canvas has no `naturalWidth`, and for those
 * `width`/`height` ARE the intrinsic dimensions.
 */
export function intrinsicSize(source: CanvasImageSource): PanelSize {
  const candidate = source as {
    naturalWidth?: unknown;
    naturalHeight?: unknown;
    width?: unknown;
    height?: unknown;
  };
  return {
    width: finite(candidate.naturalWidth) || finite(candidate.width),
    height: finite(candidate.naturalHeight) || finite(candidate.height)
  };
}

/** A dimension worth doing arithmetic with, or 0. */
function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The largest rectangle of `source`'s shape that fits inside `box`, centred.
 *
 * Contain, not cover. Both cover slots are landscape - 216 x 150 on the
 * lectern, 160 x 112 on the launch screen - and box art is almost always
 * portrait, so handing `drawImage` the slot's own width and height squashed
 * every cover in the headset by about a third. Cropping instead would keep
 * only a horizontal band through the middle of the art, which on box art is
 * the half with no title on it.
 *
 * A source with no usable size fills the box, on `visibleU`'s reasoning in
 * `screen-geometry.ts`: a stretched picture is at least recognisable as a
 * picture, while a zero-width or NaN rectangle draws nothing and is
 * indistinguishable from a cover that never loaded.
 */
export function fitContain(source: PanelSize, box: Rect): Rect {
  // A copy, not `box` itself: `launch.ts` passes its module-level `COVER`
  // constant, and handing that back would let a caller's later edit reach a
  // shared constant from a function that promises to be pure.
  if (!(source.width > 0) || !(source.height > 0)) return { ...box };

  const scale = Math.min(box.w / source.width, box.h / source.height);
  const w = source.width * scale;
  const h = source.height * scale;
  return {
    x: box.x + (box.w - w) / 2,
    y: box.y + (box.h - h) / 2,
    w,
    h
  };
}

/**
 * `text`, shortened with an ellipsis until it fits `width`.
 *
 * Every panel had its own byte-identical copy of this before it moved here,
 * and they all had one for the same reason: a canvas drawn by hand has no
 * layout engine, so text that does not fit neither wraps nor clips - it runs
 * out over whatever sits beside it, on a curved texture with nothing to
 * complain. `profile.ts` carries the note about a long translation spilling
 * out of its button and onto its neighbour.
 *
 * It measures rather than draws, which is why it can live in this module at
 * all: the caller's context is used for `measureText` and nothing else.
 *
 * The loop stops at one character instead of emptying the string. A row with
 * no text left is unpressable in practice - nobody presses what they cannot
 * read - so one letter and an ellipsis beats nothing.
 */
export function truncate(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number
): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}
