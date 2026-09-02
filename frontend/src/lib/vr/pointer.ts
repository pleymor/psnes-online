/**
 * When a controller press counts as a click.
 *
 * The raycast belongs to `scene.ts`, which has the meshes. What is here is the
 * part that runs at the headset's refresh rate and is therefore easy to get
 * catastrophically wrong: without edge detection, "trigger down over a game"
 * launches that game seventy-two times a second.
 *
 * The press edge activates, not the release. There is no cursor to slip off a
 * button with in here, so waiting for a release would only add latency to
 * something the player has already decided.
 *
 * Pure: no three, no XR, no clock, so all of the above is checkable under Bun.
 */

import type { Region } from './panel';

export interface PointerTarget {
  /** Which panel the region belongs to. The same region id can exist on two. */
  panel: string;
  region: Region;
}

export interface PointerTick {
  /** Every tick, for redrawing. */
  hover: PointerTarget | null;
  /** Once per press. */
  activated: PointerTarget | null;
}

export interface Pointer {
  update(target: PointerTarget | null, pressed: boolean): PointerTick;
}

export function sameTarget(a: PointerTarget | null, b: PointerTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.panel === b.panel && a.region.id === b.region.id;
}

export function createPointer(): Pointer {
  let wasPressed = false;

  return {
    update(target, pressed) {
      const edge = pressed && !wasPressed;
      wasPressed = pressed;
      return {
        hover: target,
        // Only on the edge, and only if the ray was already on something when
        // it happened. A trigger pressed over empty space and then dragged
        // onto a button is not a press on that button.
        activated: edge && target ? target : null
      };
    }
  };
}
