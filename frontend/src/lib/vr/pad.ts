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
 * Pure, and it reaches for nothing: the sources, the mapping and the session's
 * visibility all arrive as arguments. That is what lets the mapping and the
 * blurred-session rule be tested under Bun. The mapping itself - which input
 * carries which SNES button, and the two presets that seed it - belongs to
 * `pad-map.ts`; this module only reads one.
 */

import { PAD, type PadMask } from '$lib/znet/protocol';
import { VR_BUTTONS, type VrButton, type VrPadMap, type XrInput } from './pad-map';

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

/** The SNES mask each assignable button carries. */
const MASK: Record<VrButton, number> = {
  a: PAD.A, b: PAD.B, x: PAD.X, y: PAD.Y,
  l: PAD.L, r: PAD.R, start: PAD.START, select: PAD.SELECT
};

/**
 * Which physical input is which index, per hand.
 *
 * The RIGHT stick click is absent, and that IS the model: it carries the menu,
 * and an input outside this table can be neither captured nor assigned. The
 * left one is here - it is the ninth input, free.
 *
 * The two presets that used to live in a `FACE` table here now live in
 * `pad-map.ts` as two complete maps, because a preset is no longer the whole
 * of what this module can be told - it takes any permutation the player built.
 */
const INPUT_AT: Record<'left' | 'right', ReadonlyArray<readonly [number, XrInput]>> = {
  left: [
    [TRIGGER, 'XrLeftTrigger'],
    [SQUEEZE, 'XrLeftSqueeze'],
    [FACE_UPPER, 'XrLeftFaceUpper'],
    [FACE_LOWER, 'XrLeftFaceLower'],
    [STICK_CLICK, 'XrLeftStickClick']
  ],
  right: [
    [TRIGGER, 'XrRightTrigger'],
    [SQUEEZE, 'XrRightSqueeze'],
    [FACE_UPPER, 'XrRightFaceUpper'],
    [FACE_LOWER, 'XrRightFaceLower']
  ]
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

/**
 * The assignable inputs currently held down.
 *
 * Distinct from `readVrPad` because it answers a different question: not
 * "which SNES mask" but "which physical inputs". The two coincide only by
 * accident, and it is `CaptureGate` that consumes this one.
 *
 * The accumulator is `found`, not `held`: `held` is already the name of the
 * local function that tests one button, a few lines above.
 */
export function activeXrInputs(sources: Iterable<PadLikeSource>): XrInput[] {
  const found: XrInput[] = [];
  for (const source of sources) {
    if (!source.gamepad) continue;
    if (source.handedness !== 'left' && source.handedness !== 'right') continue;
    for (const [index, input] of INPUT_AT[source.handedness]) {
      if (held(source, index)) found.push(input);
    }
  }
  return found;
}

export function readVrPad(
  sources: Iterable<PadLikeSource>,
  map: VrPadMap,
  visibility: string
): PadMask {
  // The system menu leaves the animation loop running and stops delivering
  // input. A button held at that moment would stay held for the rest of the
  // session.
  if (visibility !== 'visible') return 0;

  // Inverted once per call: the map says button -> input, and reading needs
  // input -> mask.
  const byInput = new Map<XrInput, number>();
  for (const button of VR_BUTTONS) byInput.set(map[button], MASK[button]);

  let mask = 0;

  for (const source of sources) {
    if (!source.gamepad) continue;
    if (source.handedness !== 'left' && source.handedness !== 'right') continue;

    // Both sticks steer. The right one too, so the LEFT thumb is free for X
    // and Y - that is the whole point of `steer` being called for each hand.
    mask |= steer(source.gamepad);

    for (const [index, input] of INPUT_AT[source.handedness]) {
      if (held(source, index)) mask |= byInput.get(input) ?? 0;
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
