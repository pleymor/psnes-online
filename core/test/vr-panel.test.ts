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
import { hit, uvToCanvas, fitContain, intrinsicSize, truncate, aimable, type Region } from '../../frontend/src/lib/vr/panel.js';

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

/*
 * Fitting box art into a slot that is not its shape.
 *
 * Both cover call sites (`panels/library.ts`, `panels/launch.ts`) used to hand
 * `drawImage` the slot's own width AND height, which stretches whatever
 * arrives to whatever the slot happens to be. The slots are landscape - 216 x
 * 150 on the lectern, 160 x 112 on the launch screen - and box art is almost
 * always portrait, so every cover in the headset was squashed by about a third.
 *
 * Contain, not cover: cropping a portrait cover to a landscape slot would keep
 * only a horizontal band through its middle, which on box art is the half with
 * no title on it.
 */

test('a portrait cover in a landscape slot keeps its shape and centres', () => {
  const box = { x: 10, y: 20, w: 216, h: 150 };
  const fitted = fitContain({ width: 350, height: 500 }, box);

  assert.equal(fitted.h, 150, 'the tall axis is what the slot constrains');
  assert.equal(fitted.w, 105, '350/500 of 150');
  assert.equal(fitted.y, 20, 'no vertical slack to share');
  assert.equal(fitted.x, 10 + (216 - 105) / 2, 'the horizontal slack is split evenly');
});

test('a landscape cover in a portrait slot fills the width instead', () => {
  const fitted = fitContain({ width: 400, height: 200 }, { x: 0, y: 0, w: 100, h: 300 });

  assert.equal(fitted.w, 100);
  assert.equal(fitted.h, 50);
  assert.equal(fitted.x, 0);
  assert.equal(fitted.y, 125, 'centred in the 300 it does not need');
});

test('a source already the slot shape is left exactly alone', () => {
  const box = { x: 5, y: 7, w: 160, h: 112 };
  assert.deepEqual(fitContain({ width: 320, height: 224 }, box), box);
});

test('the fitted rectangle never leaves the slot', () => {
  const box = { x: 0, y: 0, w: 216, h: 150 };
  for (const source of [
    { width: 1, height: 1000 },
    { width: 1000, height: 1 },
    { width: 3, height: 4 },
    { width: 1920, height: 1080 }
  ]) {
    const fitted = fitContain(source, box);
    assert.ok(fitted.w <= box.w + 1e-9 && fitted.h <= box.h + 1e-9, `${source.width}x${source.height} overflowed`);
    assert.ok(fitted.x >= box.x - 1e-9 && fitted.y >= box.y - 1e-9);
  }
});

/*
 * A cover whose dimensions are not known fills the slot rather than vanishing.
 *
 * Same reasoning as `screen-geometry.ts`'s `visibleU`: a degenerate input that
 * samples everything looks like a stretched picture, which is at least
 * recognisable, whereas a zero-width or NaN rectangle draws nothing at all and
 * is indistinguishable from a cover that never loaded.
 */
test('a source with no usable size falls back to filling the slot', () => {
  const box = { x: 1, y: 2, w: 216, h: 150 };
  assert.deepEqual(fitContain({ width: 0, height: 500 }, box), box);
  assert.deepEqual(fitContain({ width: 350, height: 0 }, box), box);
  assert.deepEqual(fitContain({ width: NaN, height: 500 }, box), box);
});

/*
 * `naturalWidth` before `width`, and this is the trap worth a test.
 *
 * The covers are `new Image()` elements (`VrShell.svelte:522`). `width` on an
 * HTMLImageElement reflects the layout/attribute size, so an image carrying a
 * `width` attribute - or one read before layout - reports something that is not
 * its intrinsic shape, and the aspect ratio computed from it is wrong in a way
 * that looks exactly like the squash this fix removes.
 */
/** `CanvasImageSource` is a union of DOM types Bun has none of. */
function source(fake: object) {
  return intrinsicSize(fake as CanvasImageSource);
}

test('intrinsic size prefers naturalWidth over the layout width', () => {
  assert.deepEqual(
    source({ naturalWidth: 350, naturalHeight: 500, width: 40, height: 40 }),
    { width: 350, height: 500 }
  );
});

test('intrinsic size falls back to width for sources that have no natural one', () => {
  // An ImageBitmap or a canvas: width/height ARE the intrinsic dimensions.
  assert.deepEqual(source({ width: 256, height: 224 }), { width: 256, height: 224 });
});

test('an image that has not loaded yet reports nothing rather than zero-by-zero', () => {
  // A fresh `new Image()`: naturalWidth is 0 until `onload`. Falling back to
  // `width` is what stops a 0 propagating into the aspect ratio.
  assert.deepEqual(source({ naturalWidth: 0, naturalHeight: 0, width: 320, height: 240 }), {
    width: 320,
    height: 240
  });
});

/*
 * An `SVGImageElement` is in `CanvasImageSource`, and its `width` is an
 * `SVGAnimatedLength` object rather than a number - svelte-check refused the
 * first version of this function over exactly that. Reading it blind would put
 * an object into the aspect arithmetic and produce a NaN rectangle, which draws
 * nothing: a cover that silently disappears. It falls through to filling the
 * slot instead, which is the same answer as any other unusable size.
 */
test('a source whose dimensions are not numbers is treated as having none', () => {
  assert.deepEqual(source({ width: { value: 100 }, height: { value: 50 } }), {
    width: 0,
    height: 0
  });
  assert.deepEqual(source({}), { width: 0, height: 0 });
});

/*
 * Truncation, which every panel had its own copy of.
 *
 * Four byte-identical copies - `library.ts`, `launch.ts`, `profile.ts`,
 * `controls.ts` - and no test between them, until a fifth was about to be
 * written for the friends lectern. The reason they all have one is worth
 * keeping in view: these canvases have no layout engine, so text that does not
 * fit does not wrap or clip, it runs out over whatever sits beside it on a
 * curved texture. `profile.ts` already carries the note about a long
 * translation spilling out of its button.
 */

/** Nine pixels a character, which is what the panel tests' fake context does. */
function measuring(): CanvasRenderingContext2D {
  return {
    measureText: (text: string) => ({ width: text.length * 9 })
  } as unknown as CanvasRenderingContext2D;
}

test('text that fits is returned untouched', () => {
  assert.equal(truncate(measuring(), 'Zelda', 900), 'Zelda');
});

test('text that does not fit comes back shortened and marked', () => {
  const cut = truncate(measuring(), 'Super Mario World', 90);
  assert.ok(cut.endsWith('…'), 'a silent cut reads as a wrong title rather than a long one');
  assert.ok(cut.length * 9 <= 90);
  assert.ok('Super Mario World'.startsWith(cut.slice(0, -1)));
});

test('a width too small for anything still leaves one character', () => {
  // The loop stops at one character rather than emptying the string: a row
  // with no text at all is unpressable in practice, because nobody presses
  // what they cannot read.
  const cut = truncate(measuring(), 'Zelda', 1);
  assert.equal(cut, 'Z…');
});

test('an empty string is not padded with an ellipsis', () => {
  assert.equal(truncate(measuring(), '', 100), '');
});

test('the exact fit is a fit, not a truncation', () => {
  assert.equal(truncate(measuring(), 'abc', 27), 'abc');
});

/*
 * Quels panneaux sont visables, et pourquoi c'est une fonction.
 *
 * three's `Raycaster` only tests layers, never visibility
 * (`Raycaster.js:240`), so a mesh that is merely hidden is still hit by a ray.
 * The failure mode is the worst of its class - presses swallowed by a surface
 * the player cannot see, on whatever sits behind it - and the floating options
 * tablet is precisely a panel that spends most of its life hidden.
 */
const aimablePanel = (id: string, visible: boolean) => ({ id, mesh: { visible } });

test('a hidden panel is not a target', () => {
  const panels = [aimablePanel('library', true), aimablePanel('tablet', false)];
  assert.deepEqual(aimable(panels, true).map((p) => p.id), ['library']);
});

test('nothing is a target while the panels are dismissed', () => {
  // The trigger is the SNES pad then, not a pointer.
  assert.deepEqual(aimable([aimablePanel('library', true)], false), []);
});

test('everything visible is a target', () => {
  const panels = [aimablePanel('a', true), aimablePanel('b', true)];
  assert.equal(aimable(panels, true).length, 2);
});

test('the order survives, because hit() takes the first match', () => {
  const panels = [aimablePanel('first', true), aimablePanel('second', true)];
  assert.deepEqual(aimable(panels, true).map((p) => p.id), ['first', 'second']);
});
