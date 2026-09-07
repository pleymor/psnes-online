/**
 * Where the scene sits, decided more than once, in one three-free module.
 *
 * `layout.ts` says every distance is measured from the player's eyes, and it
 * is right about the intent: `xr-session.ts` asks for the `local` reference
 * space, whose origin is the head's pose when the session opens, so y = 0 is
 * eye level. What that arrangement does not say out loud is that the claim
 * holds for one instant. The session is granted while the Quest's boundary
 * dialog is up - while the player is still moving and the tracking still
 * settling - and the scene is then nailed to wherever the head happened to be.
 * From inside the headset that reads as the room being "sometimes far in
 * front", which is what it was reported as.
 *
 * So the anchor stops being an accident of timing and becomes something the
 * app decides: once the session is genuinely visible, again if the runtime
 * moves the origin under us, and whenever the player asks. This module is the
 * arithmetic; `scene.ts` owns the group it is applied to and `VrShell` decides
 * when.
 */

export interface Anchor {
  /** Reference-space metres. Taken as it is: eye level is the whole point. */
  position: [number, number, number];
  /** Radians about Y. */
  yaw: number;
}

/**
 * Below this, the flattened forward vector is too short to take a bearing
 * from. It is not a tolerance to tune: at a hundredth the horizontal
 * component is already within a degree of straight down, and the fallback
 * below answers those poses better than a normalised near-zero vector would.
 */
const FLAT_ENOUGH = 0.01;

/** `q` applied to `v`, without pulling in three for one rotation. */
function rotate(
  q: readonly [number, number, number, number],
  v: readonly [number, number, number]
): [number, number, number] {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // The standard expansion: v + 2w(q x v) + 2(q x (q x v)).
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx)
  ];
}

/**
 * The anchor a head at `position` facing `quaternion` should give the scene.
 *
 * YAW ONLY, and that is the point rather than a simplification. Carrying the
 * pitch would tip the whole room back with the player's head and carrying the
 * roll would bank it, and nothing in the design asks for either - the scene's
 * geometry already decides how it faces the eyes, which is what `layout.ts`'s
 * forty-degree lecterns are.
 *
 * The yaw is read from the forward vector flattened onto the floor. A head
 * looking straight down has no flattened forward vector - it projects to a
 * point - and `atan2(0, 0)` would answer zero, silently snapping the room to
 * face -Z, which from inside a headset looks like the room jumping for no
 * reason. In that pose the rotated UP vector is the one still carrying a
 * horizontal direction, so it stands in: pointing the way the player faces
 * when they look down, and the opposite way when they look up, hence the sign.
 */
export function anchorFrom(
  position: readonly [number, number, number],
  quaternion: readonly [number, number, number, number]
): Anchor {
  const forward = rotate(quaternion, [0, 0, -1]);

  let [bx, , bz] = forward;
  if (Math.hypot(bx, bz) < FLAT_ENOUGH) {
    const up = rotate(quaternion, [0, 1, 0]);
    const sign = forward[1] < 0 ? 1 : -1;
    bx = sign * up[0];
    bz = sign * up[2];
  }

  // A yaw of t maps -Z to (-sin t, 0, -cos t), so the bearing inverts to this.
  return { position: [position[0], position[1], position[2]], yaw: Math.atan2(-bx, -bz) };
}
