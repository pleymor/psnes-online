/**
 * Two Touch controllers, one 12-bit SNES mask.
 *
 * It produces exactly what `InputCollector.read()` produces and shares none of
 * its codes, on purpose. `controls/binding.ts`'s `STANDARD_PAD` speaks the
 * `standard` gamepad mapping, where the left stick is axes 0 and 1. A Touch
 * controller speaks `xr-standard`, where axes 0 and 1 belong to a touchpad it
 * does not have and the stick is on 2 and 3. Reusing that table gives a dead
 * d-pad with no error and no warning, so the two tables stay apart.
 *
 * Pure, and it reaches for nothing: the sources and the session's visibility
 * both arrive as arguments. That is what lets both presets and the
 * blurred-session rule be tested under Bun.
 */

import { PAD, type PadMask } from '$lib/znet/protocol';
import type { VrPadScheme } from './pad-scheme';

/** The part of `XRInputSource` this reads. */
export interface PadLikeSource {
  handedness: string;
  gamepad?: {
    buttons: readonly { pressed: boolean }[];
    axes: readonly number[];
  } | null;
}

/** The same value `znet/input.ts:31` uses, so a stick feels the same in both
 * modes. */
export const XR_AXIS_THRESHOLD = 0.5;

/* `xr-standard` button indices. Named because `buttons[5]` at a call site is
 * how the two face buttons end up swapped by someone counting from the wrong
 * end. */
export const TRIGGER = 0;
const SQUEEZE = 1;
const STICK_CLICK = 3;
const FACE_LOWER = 4;
const FACE_UPPER = 5;

/** The thumbstick, and the reason this module exists. */
const STICK_X = 2;
const STICK_Y = 3;

/**
 * The four action buttons, per preset: [upper, lower] of each hand.
 *
 * The SNES diamond (X top, Y left, A right, B bottom) has to fold onto two
 * vertical pairs, and no folding is free. `letters` keeps the printed letter
 * honest. `thumb` puts SNES B (jump) and SNES Y (run) on the two lower buttons,
 * where the thumbs already rest.
 */
const FACE: Record<VrPadScheme, { left: [number, number]; right: [number, number] }> = {
  letters: { left: [PAD.Y, PAD.X], right: [PAD.B, PAD.A] },
  thumb: { left: [PAD.X, PAD.Y], right: [PAD.A, PAD.B] }
};

function held(source: PadLikeSource, index: number): boolean {
  return source.gamepad?.buttons[index]?.pressed === true;
}

/**
 * The d-pad contribution of one thumbstick.
 *
 * Called for BOTH hands, and that is ergonomics rather than generosity. With
 * only the left stick steering, the left thumb is occupied for as long as the
 * player is moving - and SNES X and Y live on the left controller's face, so
 * half the button map was unreachable in motion. Reported from actual play.
 *
 * The objection this replaces was that a d-pad on both hands "would fight
 * itself the moment a player rested a thumb on the right one". It does not: a
 * resting thumb reads about zero and never crosses XR_AXIS_THRESHOLD. Getting
 * a conflict takes pushing both sticks in opposite directions at once, which
 * is deliberate, and which the caller's OR then reports as both directions
 * held - exactly what real hardware does when somebody presses left and right
 * together.
 *
 * Still only from a hand: `handedness` is checked at the call sites, so an
 * input source that is neither left nor right never steers.
 */
function steer(gamepad: NonNullable<PadLikeSource['gamepad']>): PadMask {
  let mask = 0;
  const x = gamepad.axes[STICK_X] ?? 0;
  const y = gamepad.axes[STICK_Y] ?? 0;
  if (x <= -XR_AXIS_THRESHOLD) mask |= PAD.LEFT;
  if (x >= XR_AXIS_THRESHOLD) mask |= PAD.RIGHT;
  if (y <= -XR_AXIS_THRESHOLD) mask |= PAD.UP;
  if (y >= XR_AXIS_THRESHOLD) mask |= PAD.DOWN;
  return mask;
}

export function readVrPad(
  sources: Iterable<PadLikeSource>,
  scheme: VrPadScheme,
  visibility: string
): PadMask {
  // The system menu leaves the animation loop running and stops delivering
  // input. A button held at that moment would stay held for the rest of the
  // session.
  if (visibility !== 'visible') return 0;

  let mask = 0;
  const face = FACE[scheme];

  for (const source of sources) {
    if (!source.gamepad) continue;

    if (source.handedness === 'left') {
      mask |= steer(source.gamepad);
      if (held(source, FACE_UPPER)) mask |= face.left[0];
      if (held(source, FACE_LOWER)) mask |= face.left[1];
      if (held(source, TRIGGER)) mask |= PAD.L;
      if (held(source, SQUEEZE)) mask |= PAD.SELECT;
    } else if (source.handedness === 'right') {
      // The right stick steers so the LEFT thumb is free for X and Y. That is
      // the whole point of `steer` being called twice.
      mask |= steer(source.gamepad);
      if (held(source, FACE_UPPER)) mask |= face.right[0];
      if (held(source, FACE_LOWER)) mask |= face.right[1];
      if (held(source, TRIGGER)) mask |= PAD.R;
      if (held(source, SQUEEZE)) mask |= PAD.START;
    }
  }

  return mask;
}

/**
 * The right thumbstick click, which is the only way out.
 *
 * The Quest's menu button is reserved by the system and delivers nothing to the
 * page, so there is no hardware button available for "leave". This recalls the
 * panels, and the profile band carries the exit.
 */
export function menuPressed(sources: Iterable<PadLikeSource>): boolean {
  for (const source of sources) {
    if (source.handedness === 'right' && held(source, STICK_CLICK)) return true;
  }
  return false;
}
