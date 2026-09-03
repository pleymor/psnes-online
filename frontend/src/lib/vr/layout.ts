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

const LECTERN_DISTANCE = 1.2;
/** 60 degrees off centre: peripheral, so it is not in the way, but reachable by
 * a glance rather than a turn of the whole body. */
const LECTERN_AZIMUTH = Math.PI / 3;
/** How far below the eyes the lecterns hang. */
const LECTERN_DROP = 0.45;
/** 40 degrees, tipped back so a lowered panel faces raised eyes. */
const LECTERN_PITCH = -(Math.PI * 40) / 180;
const LECTERN_WIDTH = 0.7;
const LECTERN_HEIGHT = 0.5;

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
