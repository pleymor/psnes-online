/**
 * Turning a raycast hit into a button press.
 *
 * There is no DOM in an immersive session, so a panel is a canvas drawn by hand
 * and a list of rectangles. All the pointing reduces to this: three.js hands
 * back a `uv` on the mesh, and this says which rectangle that is.
 *
 * The one trap is the v axis, and it is the same trap `znet/webgl-renderer.ts`
 * spends a paragraph on: a plane's uv has v = 0 at the BOTTOM, while a canvas
 * has y = 0 at the TOP. So v is flipped exactly once, here. Get it wrong and
 * every click lands on the button vertically opposite the one being pointed at
 * - which looks like a random mis-click rather than an inverted axis, and is
 * therefore very hard to spot from a headset.
 *
 * Keeping this pure is the whole reason panel layout is testable at all: no
 * canvas, no texture, no three. Those belong to `scene.ts`.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { hit, uvToCanvas, type Region } from '../../frontend/src/lib/vr/panel.js';

const SIZE = { width: 800, height: 400 };

test('v is flipped exactly once, from GL bottom-up to canvas top-down', () => {
  assert.deepEqual(uvToCanvas({ x: 0, y: 1 }, SIZE), { x: 0, y: 0 }, 'uv top is canvas top');
  assert.deepEqual(uvToCanvas({ x: 0, y: 0 }, SIZE), { x: 0, y: 400 }, 'uv bottom is canvas bottom');
  assert.deepEqual(uvToCanvas({ x: 1, y: 0.5 }, SIZE), { x: 800, y: 200 });
});

const REGIONS: Region[] = [
  { id: 'first', x: 0, y: 0, w: 100, h: 50 },
  { id: 'second', x: 0, y: 60, w: 100, h: 50 },
  { id: 'wide', x: 200, y: 0, w: 400, h: 400 }
];

test('a point inside a rectangle finds it', () => {
  // Canvas y = 25 is uv v = 1 - 25/400.
  const found = hit(REGIONS, { x: 50 / 800, y: 1 - 25 / 400 }, SIZE);
  assert.equal(found?.id, 'first');
});

test('the flip is not cosmetic: the wrong sign hits the wrong button', () => {
  // Aim at 'second', whose canvas band is y 60..110.
  const uv = { x: 50 / 800, y: 1 - 85 / 400 };
  assert.equal(hit(REGIONS, uv, SIZE)?.id, 'second');
  // The same v read without flipping lands at canvas y 315, which is inside
  // nothing here - so a broken flip shows up as a dead panel, not as a
  // plausible-looking wrong answer.
  const unflipped = { x: 50 / 800, y: 85 / 400 };
  assert.equal(hit(REGIONS, unflipped, SIZE), null);
});

test('the gap between two rectangles is nothing at all', () => {
  const found = hit(REGIONS, { x: 50 / 800, y: 1 - 55 / 400 }, SIZE);
  assert.equal(found, null, 'a click in a margin must not fall through to a neighbour');
});

test('edges belong to the rectangle, inclusively on the near side', () => {
  assert.equal(hit(REGIONS, { x: 0, y: 1 }, SIZE)?.id, 'first', 'the top-left corner is inside');
  // Canvas y = 50 is 'first''s bottom edge and 'second' does not start until 60.
  assert.equal(hit(REGIONS, { x: 0, y: 1 - 50 / 400 }, SIZE)?.id, 'first');
  // One pixel past it is outside.
  assert.equal(hit(REGIONS, { x: 0, y: 1 - 50.5 / 400 }, SIZE), null);
});

test('the first matching rectangle wins, so order is the z-order', () => {
  const overlapping: Region[] = [
    { id: 'on-top', x: 0, y: 0, w: 100, h: 100 },
    { id: 'beneath', x: 0, y: 0, w: 800, h: 400 }
  ];
  assert.equal(hit(overlapping, { x: 0.01, y: 0.99 }, SIZE)?.id, 'on-top');
  assert.equal(hit(overlapping, { x: 0.9, y: 0.1 }, SIZE)?.id, 'beneath');
});

test('a uv outside the mesh hits nothing rather than clamping', () => {
  assert.equal(hit(REGIONS, { x: -0.1, y: 0.5 }, SIZE), null);
  assert.equal(hit(REGIONS, { x: 1.1, y: 0.5 }, SIZE), null);
  assert.equal(hit(REGIONS, { x: 0.5, y: 1.2 }, SIZE), null);
});

test('an empty region list is simply no hit', () => {
  assert.equal(hit([], { x: 0.5, y: 0.5 }, SIZE), null);
});
