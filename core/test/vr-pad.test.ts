/**
 * Two Touch controllers read as one SNES pad.
 *
 * Two traps, both silent if got wrong.
 *
 * The first is `xr-standard` versus `standard`. A Touch thumbstick reports on
 * `axes[2]`/`axes[3]`; the first two axes belong to a touchpad these
 * controllers do not have. `controls/binding.ts:73` codes `PadAxis0Minus` for
 * up, so reusing that table would yield a dead d-pad with no error and no
 * warning - which is exactly why this module has its own table and shares no
 * codes with `InputCollector`.
 *
 * The second is `visible-blurred`. When the Quest system menu opens, the XR
 * animation loop keeps firing but input stops being delivered. A button held at
 * that instant would stay held forever and the character would run right on its
 * own. This returns a zero mask instead - the same reasoning as
 * `InputCollector.onBlur = () => this.held.clear()` (`znet/input.ts:66`).
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readVrPad, menuPressed, XR_AXIS_THRESHOLD } from '../../frontend/src/lib/vr/pad.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';

/** An `XRInputSource`-shaped controller. `xr-standard` button order:
 *  0 trigger, 1 squeeze, 2 touchpad (absent), 3 thumbstick press,
 *  4 lower face button (A / X), 5 upper face button (B / Y). */
function controller(handedness: 'left' | 'right', opts: {
  buttons?: number[];
  stick?: [number, number];
} = {}) {
  const pressed = new Set(opts.buttons ?? []);
  const [x, y] = opts.stick ?? [0, 0];
  return {
    handedness,
    gamepad: {
      buttons: Array.from({ length: 6 }, (_, i) => ({ pressed: pressed.has(i) })),
      axes: [0, 0, x, y]
    }
  };
}

test('nothing pressed is a zero mask', () => {
  assert.equal(readVrPad([controller('left'), controller('right')], 'letters', 'visible'), 0);
});

test('letters: what is written on the controller is what the game names', () => {
  const mask = readVrPad(
    [controller('left', { buttons: [4, 5] }), controller('right', { buttons: [4, 5] })],
    'letters',
    'visible'
  );
  // left lower = X -> SNES X, left upper = Y -> SNES Y,
  // right lower = A -> SNES A, right upper = B -> SNES B
  assert.equal(mask, PAD.X | PAD.Y | PAD.A | PAD.B);
});

test('letters puts the Mario jump on the upper right button', () => {
  const upperRight = readVrPad([controller('right', { buttons: [5] })], 'letters', 'visible');
  assert.equal(upperRight, PAD.B, 'SNES B is the bottom of the diamond but the top of the hand');
});

test('thumb: the jump moves to where the thumb already rests', () => {
  const lowerRight = readVrPad([controller('right', { buttons: [4] })], 'thumb', 'visible');
  assert.equal(lowerRight, PAD.B, 'Quest A carries SNES B under the thumb');

  const upperRight = readVrPad([controller('right', { buttons: [5] })], 'thumb', 'visible');
  assert.equal(upperRight, PAD.A);

  const lowerLeft = readVrPad([controller('left', { buttons: [4] })], 'thumb', 'visible');
  assert.equal(lowerLeft, PAD.Y, 'Quest X carries SNES Y - run, held constantly');

  const upperLeft = readVrPad([controller('left', { buttons: [5] })], 'thumb', 'visible');
  assert.equal(upperLeft, PAD.X);
});

test('the preset touches only the four face buttons', () => {
  const shoulders = [
    controller('left', { buttons: [0, 1] }),
    controller('right', { buttons: [0, 1] })
  ];
  const expected = PAD.L | PAD.SELECT | PAD.R | PAD.START;
  assert.equal(readVrPad(shoulders, 'letters', 'visible'), expected);
  assert.equal(readVrPad(shoulders, 'thumb', 'visible'), expected, 'shoulders and Start are not a preference');
});

test('the d-pad comes off axes 2 and 3, never 0 and 1', () => {
  const dead = readVrPad([controller('left', { stick: [-1, -1] })], 'letters', 'visible');
  assert.notEqual(dead, 0, 'a stick read on axes 0/1 would report nothing here');
  assert.equal(dead, PAD.LEFT | PAD.UP);

  assert.equal(
    readVrPad([controller('left', { stick: [1, 1] })], 'letters', 'visible'),
    PAD.RIGHT | PAD.DOWN
  );
});

test('the stick has to be pushed past the threshold to count', () => {
  const under = XR_AXIS_THRESHOLD - 0.01;
  assert.equal(readVrPad([controller('left', { stick: [under, 0] })], 'letters', 'visible'), 0);
  const over = XR_AXIS_THRESHOLD + 0.01;
  assert.equal(readVrPad([controller('left', { stick: [over, 0] })], 'letters', 'visible'), PAD.RIGHT);
});

test('only the left stick steers', () => {
  assert.equal(readVrPad([controller('right', { stick: [-1, 0] })], 'letters', 'visible'), 0);
});

test('a blurred session reads as nothing held', () => {
  const held = [controller('right', { buttons: [4, 5] }), controller('left', { stick: [1, 0] })];
  assert.equal(readVrPad(held, 'letters', 'visible'), PAD.A | PAD.B | PAD.RIGHT);
  assert.equal(readVrPad(held, 'letters', 'visible-blurred'), 0, 'the system menu must not weld a button down');
  assert.equal(readVrPad(held, 'letters', 'hidden'), 0);
});

test('a controller with no gamepad is skipped rather than fatal', () => {
  const sources = [
    { handedness: 'right', gamepad: null },
    { handedness: 'none' },
    controller('left', { buttons: [0] })
  ];
  assert.equal(readVrPad(sources, 'letters', 'visible'), PAD.L);
});

test('the right thumbstick click is the way back to the panels', () => {
  assert.equal(menuPressed([controller('right', { buttons: [3] })]), true);
  assert.equal(menuPressed([controller('left', { buttons: [3] })]), false, 'the left click is Select-adjacent, not the menu');
  assert.equal(menuPressed([controller('right', { buttons: [4] })]), false);
});
