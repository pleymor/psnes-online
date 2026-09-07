/**
 * Every distance and angle in the VR scene, in one three-free module.
 *
 * None of these numbers is measured. They are reasoned starting points, and the
 * only way to settle them is to put a headset on: that is precisely why they
 * live apart from anything that draws, so tuning them is a one-file change.
 *
 * The layout is the "cockpit" of the three that were considered. The screen is
 * a wide arc at 2.5 m; the two lecterns are much nearer, lower, and yawed
 * inward. That nearness is the entire reason this shape won - legibility
 * follows angular distance, not panel size, so a cover grid on a 3 m arc is
 * unreadable however large the panel is.
 *
 * Coordinates are three.js's: the player stands at the origin looking down -Z,
 * +X to their right, +Y up.
 */

import { aspectRatioOf, type PixelAspect } from '$lib/znet/fit';
import type { PanelSize } from './panel';

export interface Placement {
  position: [number, number, number];
  /** Radians, `[pitch, yaw, 0]`. Negative pitch tips the top away from the
   * player, turning a lowered panel's face up toward the eyes. */
  rotation: [number, number, number];
  /** Metres. */
  width: number;
  height: number;
}

export interface ScreenPlacement {
  radius: number;
  /** Radians of arc the cylinder segment covers. */
  arc: number;
  height: number;
  centerY: number;
}

export interface SceneLayout {
  screen: ScreenPlacement;
  library: Placement;
  friends: Placement;
  profile: Placement;
}

/*
 * Every y here is measured from the player's eyes, not from the floor.
 *
 * That follows from the reference space: `xr-session.ts` asks for `local`
 * only, whose origin is the head's pose when the session opens, so y = 0 is
 * eye level. It used to ask for `local-floor` and place everything from a
 * guessed 1.6 m eye height, which was wrong for anybody sitting down - and
 * which the old `local` fallback would have hung a full 1.6 m overhead.
 *
 * There is no height left to guess: the scene is placed where the head
 * actually was.
 */

const SCREEN_RADIUS = 2.5;
/** 60 degrees. Wide enough to fill the view, narrow enough that the edges are
 * not behind the player's cheekbones. */
const SCREEN_ARC = Math.PI / 3;

/**
 * The horizontal radius, not the distance - `eyeDistance` is the distance.
 *
 * Brought in from 1.2 with the width taken up to 0.95 at the same time. The
 * two together are what carried the lecterns from 30.5 degrees of view to
 * 44.8, because 30.5 was measured and reported as too small to read without
 * leaning in. Neither constant alone gets there without going somewhere
 * uncomfortable: the panel would have to reach 1.0 m across to do it from
 * 1.2 m, or sit at 0.8 m to do it at its old size.
 */
const LECTERN_DISTANCE = 1.06;
/** 60 degrees off centre: peripheral, so it is not in the way, but reachable by
 * a glance rather than a turn of the whole body. */
const LECTERN_AZIMUTH = Math.PI / 3;
/** How far below the eyes the lecterns hang. */
const LECTERN_DROP = 0.45;
/** 40 degrees, tipped back so a lowered panel faces raised eyes. */
const LECTERN_PITCH = -(Math.PI * 40) / 180;
const LECTERN_WIDTH = 0.95;
/**
 * 0.95 / (1120 / 840), and the division is the point.
 *
 * `panel-mesh.ts` maps the whole canvas onto the whole plane, uv 0..1 on both
 * axes, so a lectern whose metres are not the shape of its canvas stretches
 * every glyph on it. It was once 0.5 against an 800 x 600 canvas, which is
 * 1.40 over 1.3333: five per cent too wide, everywhere, invisible as a defect
 * and quietly wrong. `vr-layout.test.ts` holds the two numbers together from
 * now on, which is what makes changing either safe.
 */
const LECTERN_HEIGHT = 0.7125;

const BAND_DISTANCE = 1.0;
const BAND_DROP = 0.75;
const BAND_PITCH = -(Math.PI * 55) / 180;
const BAND_WIDTH = 0.9;
const BAND_HEIGHT = 0.3;

/**
 * A lectern at `azimuth`, facing the player.
 *
 * The yaw is the negative of the azimuth: a plane's normal starts at +Z, and
 * rotating by -azimuth about Y turns it back toward the origin. Getting the
 * sign wrong here shows the player the back of an invisible panel, which reads
 * as "the panel did not load".
 */
function lectern(azimuth: number): Placement {
  return {
    position: [
      LECTERN_DISTANCE * Math.sin(azimuth),
      -LECTERN_DROP,
      -LECTERN_DISTANCE * Math.cos(azimuth)
    ],
    rotation: [LECTERN_PITCH, -azimuth, 0],
    width: LECTERN_WIDTH,
    height: LECTERN_HEIGHT
  };
}

export function sceneLayout(aspect: PixelAspect): SceneLayout {
  // Arc length is the screen's width, so the height is what the player's
  // aspect choice actually decides.
  const screenWidth = SCREEN_RADIUS * SCREEN_ARC;

  return {
    screen: {
      radius: SCREEN_RADIUS,
      arc: SCREEN_ARC,
      height: screenWidth / aspectRatioOf(aspect),
      // Straight ahead: the picture is what the player came for, so it goes
      // where they are already looking rather than above or below it.
      centerY: 0
    },
    library: lectern(-LECTERN_AZIMUTH),
    friends: lectern(LECTERN_AZIMUTH),
    profile: {
      position: [0, -BAND_DROP, -BAND_DISTANCE],
      rotation: [BAND_PITCH, 0, 0],
      width: BAND_WIDTH,
      height: BAND_HEIGHT
    }
  };
}

/**
 * What a Quest 3 can actually show, in pixels per degree of view.
 *
 * 2064 x 2208 per eye behind a lens that puts roughly 25 pixels into each
 * central degree. It is a device figure, not a measurement of ours, and it is
 * here rather than inline because it is the yardstick every panel's canvas is
 * sized against - see `pixelsPerDegree`.
 */
export const QUEST_3_PIXELS_PER_DEGREE = 25;

/**
 * Metres from the eyes to a panel's centre.
 *
 * NOT `LECTERN_DISTANCE`. That constant is the horizontal radius, and the drop
 * below eye level is the other leg of the triangle: a lectern 1.06 out and
 * 0.45 down is 1.15 away. Computing an angle from the radius alone overstates
 * it by that ratio, which is a mistake already made once on this file.
 */
export function eyeDistance(placement: Placement): number {
  const [x, y, z] = placement.position;
  return Math.hypot(x, y, z);
}

/**
 * How much of the view a panel takes up, in degrees.
 *
 * This is the number legibility answers to, and the reason this module's
 * header calls the cockpit layout the one that won: a panel's size in metres
 * means nothing on its own. Measured across the width, which is the axis the
 * canvases are widest on and the one the text runs along.
 */
export function angularWidth(placement: Placement): number {
  return (2 * Math.atan(placement.width / 2 / eyeDistance(placement)) * 180) / Math.PI;
}

/**
 * A panel's canvas resolution expressed in the same units as the headset's.
 *
 * The two want to be about equal, and both directions of mismatch cost
 * something. Below the display's figure the canvas is the limit: its pixels
 * are magnified, so the text is soft - which is the trap in enlarging a
 * panel's metres and leaving its canvas alone. Far above it the extra pixels
 * are drawn and then thrown away, and they were worse than useless while
 * these textures had mipmaps, because there was no detail beneath the
 * display's reach for a mip level to protect.
 */
export function pixelsPerDegree(placement: Placement, canvas: PanelSize): number {
  return canvas.width / angularWidth(placement);
}
