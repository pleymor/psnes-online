/**
 * The screen's mesh, generated rather than taken from three.
 *
 * The reason is the frame buffer's padding. `videoSurface()` is a zero-copy
 * view whose stride is fixed at 512 pixels however wide the picture actually
 * is, so at the usual 256 half of every row is memory nobody should see.
 * `videoFrame()` repacks it tightly and pays a whole copy per frame.
 *
 * Neither is necessary. Upload the padded buffer as a stride-wide texture, and
 * generate u coordinates that stop at `width / stride`: the padding is never
 * sampled, there is no copy, and no custom GL state is needed. Generating uvs
 * means generating the mesh - hence this module, and hence the pleasant
 * side-effect that all of it is a pure function.
 *
 * Coordinates are three.js's, as in `layout.ts`: origin at the player, looking
 * down -Z. The mesh is centred on its own origin vertically; `layout.ts` says
 * where it goes.
 *
 * Curved and flat are one function rather than two, and share every vertex
 * index, uv and winding - only x and z differ. The player chooses between them
 * at run time (`screen-shape.ts`), so the two shapes are swapped on a live
 * mesh; two code paths would mean an enroulement or a uv range that is only
 * right in one of them, and a screen wound the wrong way is invisible rather
 * than wrong-looking. Both shapes cover the SAME arc, which is what makes the
 * choice a matter of form and not a second size setting.
 */

export interface ScreenSpec {
  /** Metres from the eye to the centre of the picture. The cylinder's radius
   *  when curved, the plane's depth when flat. */
  distance: number;
  /** Radians of horizontal field of view the picture covers, in both shapes. */
  arc: number;
  height: number;
  /** Horizontal subdivisions. Enough that the curve does not facet visibly;
   * 48 is comfortable at 2.5 m. Kept for the flat shape too, where two would
   * do, so that swapping shapes never re-allocates a different mesh size. */
  segments?: number;
  /** The right edge of the sampled region. From `visibleU`. */
  uMax: number;
  /** Defaults to curved, which is what every screen was before the setting. */
  curved?: boolean;
}

export interface ScreenGeometry {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
}

const DEFAULT_SEGMENTS = 48;

/**
 * The fraction of a padded row that is real picture.
 *
 * Degenerate inputs sample everything rather than nothing: a zero here would
 * make the screen a single column of pixels, which looks like a rendering bug
 * with no obvious cause, whereas showing the padding at least looks like
 * padding.
 */
export function visibleU(width: number, stride: number): number {
  if (!(stride > 0) || !(width > 0)) return 1;
  return Math.min(width / stride, 1);
}

/**
 * How wide the picture is, in metres, for a given angle and shape.
 *
 * Two formulas because the arc is what is held constant. Curved, the picture
 * IS the arc, so its width is the arc length. Flat, its edges are further from
 * the eye than its centre, so covering the same angle takes a wider picture -
 * `2 d tan(arc/2)` rather than `d arc`, about 10 % more at 60 degrees.
 *
 * Exported because `layout.ts` needs the same number to divide by the aspect
 * ratio: a flat screen given the curved width would be visibly stretched, and
 * the stretch would look like a decoding bug rather than a layout one.
 */
export function screenWidth(distance: number, arc: number, curved: boolean): number {
  return curved ? distance * arc : 2 * distance * Math.tan(arc / 2);
}

export function screenGeometry(spec: ScreenSpec): ScreenGeometry {
  // `Math.max(1, ...)` closes off `segments: 0`, which would otherwise divide
  // by zero in `t = i / segments` below and produce a silent NaN mesh - an
  // invisible screen inside a headset, indistinguishable from a game that
  // failed to boot. Unreachable today (the only caller omits the argument),
  // but the failure mode is the most expensive one on this branch to
  // diagnose, so it is closed even with nothing yet able to trigger it.
  const segments = Math.max(1, spec.segments ?? DEFAULT_SEGMENTS);
  const columns = segments + 1;
  const half = spec.arc / 2;
  const top = spec.height / 2;
  const curved = spec.curved ?? true;
  /** Only read on the flat branch, where x is linear rather than angular. */
  const halfWidth = screenWidth(spec.distance, spec.arc, false) / 2;

  const positions = new Float32Array(columns * 2 * 3);
  const uvs = new Float32Array(columns * 2 * 2);
  const indices = new Uint16Array(segments * 6);

  for (let i = 0; i < columns; i++) {
    const t = i / segments;
    const angle = -half + spec.arc * t;
    /*
     * The one difference between the two shapes.
     *
     * Curved: the column sits on the cylinder at its own angle. Flat: x is
     * spread linearly across the chord and z is constant, so the edges are
     * further from the eye - which is exactly what a flat screen is.
     *
     * `u` is NOT adjusted for that. A flat screen's edges are stretched
     * slightly, the same way a real flat panel viewed from its centre is;
     * correcting it here would be a projection the picture never asked for.
     */
    const x = curved ? spec.distance * Math.sin(angle) : -halfWidth + 2 * halfWidth * t;
    const z = curved ? -spec.distance * Math.cos(angle) : -spec.distance;
    const u = spec.uMax * t;

    // Vertex 2i is this column's bottom, 2i+1 its top.
    const bottom = (i * 2) * 3;
    positions[bottom] = x;
    positions[bottom + 1] = -top;
    positions[bottom + 2] = z;
    positions[bottom + 3] = x;
    positions[bottom + 4] = top;
    positions[bottom + 5] = z;

    const uv = (i * 2) * 2;
    uvs[uv] = u;
    uvs[uv + 1] = 0;
    uvs[uv + 2] = u;
    uvs[uv + 3] = 1;
  }

  /*
   * Winding, and why it gets its own comment.
   *
   * The player is at the origin looking down -Z, so their right is +X and up is
   * +Y. Bottom-left, then bottom-right, then top-left is counter-clockwise from
   * where they stand, which is three's default front face. Reversed, the screen
   * is invisible - and an invisible screen inside a headset is
   * indistinguishable from a game that failed to boot, so this is a bug that
   * costs an hour to diagnose and a character to fix.
   */
  for (let i = 0; i < segments; i++) {
    const bl = i * 2;
    const tl = bl + 1;
    const br = bl + 2;
    const tr = bl + 3;
    const o = i * 6;
    indices[o] = bl;
    indices[o + 1] = br;
    indices[o + 2] = tl;
    indices[o + 3] = br;
    indices[o + 4] = tr;
    indices[o + 5] = tl;
  }

  return { positions, uvs, indices };
}
