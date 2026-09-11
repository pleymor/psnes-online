/**
 * The layer plane, remapped into the mask the stacked screen is cut with.
 *
 * Everything the headset shows about depth passes through this one loop, and
 * none of it can be seen from inside a `WebGLRenderer` - a mask that is one
 * pixel out, or a row short, produces a picture that looks like the layers
 * were assigned at random. So the loop lives in a module with no three in it
 * and the properties are asserted here.
 *
 * The stride is the one to watch. The mask is sampled with the SAME `texSize`
 * as the picture, so packing it tightly - which is the obvious thing to do,
 * since half of every row is padding nobody sees - slides each row sideways
 * against the frame it describes by a growing amount. That is a diagonal smear
 * and it does not look like a stride bug.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createSlotMaskBuilder, hasSlot, SLOT_COUNT } from '../../frontend/src/lib/vr/slot-mask.js';
import { VR_SLOT_KEYS, slotTable } from '../../frontend/src/lib/vr/layer-map.js';

const MAIN = 32; // D for the main screen, as in `vr-layer-map.test.ts`

const indexOf = (key: (typeof VR_SLOT_KEYS)[number]) => VR_SLOT_KEYS.indexOf(key);

/** A plane of `fill`, with `write` free to poke individual pixels into it. */
function plane(
  width: number,
  height: number,
  stride: number,
  fill: number,
  write?: (data: Uint8Array) => void
) {
  const data = new Uint8Array(stride * height).fill(fill);
  write?.(data);
  return { data, width, height, stride, mode: 1, bg3Priority: false };
}

test('every pixel carries the slot its priority byte names', () => {
  const builder = createSlotMaskBuilder();
  const depth = plane(4, 2, 8, MAIN + 15, (data) => {
    data[0] = 1; // the backdrop's literal
    data[1] = MAIN + 4; // a sprite
    data[9] = MAIN + 3; // BG3, low half
  });

  const { data } = builder.build(depth);
  assert.equal(data[0], indexOf('backdrop'));
  assert.equal(data[1], indexOf('sprite'));
  assert.equal(data[2], indexOf('bg1.hi'));
  assert.equal(data[9], indexOf('bg3.lo'));
});

test('the mask keeps the plane stride, so its rows sit under the picture rows', () => {
  const builder = createSlotMaskBuilder();
  // Row 1 starts at 8, not at 4. A tightly packed mask would put this byte at
  // index 4 and every row below it would drift another four pixels left.
  const depth = plane(4, 3, 8, 1, (data) => {
    data[8] = MAIN + 4;
  });

  const { data } = builder.build(depth);
  assert.equal(data.length, 8 * 3);
  assert.equal(data[8], indexOf('sprite'));
  assert.notEqual(data[4], indexOf('sprite'), 'the rows were packed tightly');
});

test('the padded tail of a row is left alone and never counted', () => {
  const builder = createSlotMaskBuilder();
  // A sprite byte sitting in the padding. The shader clamps to `uMax` and can
  // never sample it, so lighting up the sprite plane for it would be ten
  // planes of full-screen discard bought with memory nobody can see.
  const depth = plane(4, 1, 8, 1, (data) => {
    data[6] = MAIN + 4;
  });

  const { data, present } = builder.build(depth);
  // Untouched, which reads as the backdrop if anything ever did sample it.
  assert.notEqual(data[6], indexOf('sprite'), 'the padding was remapped');
  assert.ok(!hasSlot(present, indexOf('sprite')));
  assert.ok(hasSlot(present, indexOf('backdrop')));
});

test('present names exactly the slots the picture contains', () => {
  const builder = createSlotMaskBuilder();
  const depth = plane(4, 2, 8, MAIN + 15, (data) => {
    data[0] = MAIN + 4;
  });

  const { present } = builder.build(depth);
  assert.ok(hasSlot(present, indexOf('bg1.hi')));
  assert.ok(hasSlot(present, indexOf('sprite')));
  assert.ok(!hasSlot(present, indexOf('backdrop')));
  assert.ok(!hasSlot(present, indexOf('bg2.lo')));
  // Every slot fits in the bitmask, which is what lets `present` be one int.
  assert.ok(SLOT_COUNT <= 32);
  assert.equal(SLOT_COUNT, VR_SLOT_KEYS.length);
});

test('an unknown byte becomes the backdrop rather than a plane that jumps forward', () => {
  // `slotTable`'s rule, restated at this level because it is the safe mistake:
  // an unexpected value produces a pixel that did not move.
  const builder = createSlotMaskBuilder();
  const { data } = builder.build(plane(2, 1, 4, 200));
  assert.equal(data[0], indexOf('backdrop'));
});

test('the LUT survives a frame, and only a mode change rebuilds it', () => {
  const builder = createSlotMaskBuilder();
  const first = plane(2, 1, 4, MAIN + 15);
  builder.build(first);
  const table = builder.table();

  builder.build(plane(2, 1, 4, MAIN + 15));
  assert.equal(builder.table(), table, 'the LUT was rebuilt for an unchanged frame');

  builder.build({ ...plane(2, 1, 4, MAIN + 15), mode: 3 });
  assert.notEqual(builder.table(), table, 'a mode change did not rebuild the LUT');
});

test('BG3Priority alone rebuilds the LUT, because it alone moves BG3', () => {
  const builder = createSlotMaskBuilder();
  builder.build(plane(2, 1, 4, MAIN + 17));
  const table = builder.table();

  const { data } = builder.build({ ...plane(2, 1, 4, MAIN + 17), bg3Priority: true });
  assert.notEqual(builder.table(), table);
  // The status bar case from `layer-map.ts`: with the flag, 32+17 is BG3's
  // high half, and without it the byte names nothing at all.
  assert.equal(data[0], indexOf('bg3.hi'));
});

test('the mask agrees with slotTable byte for byte', () => {
  // The builder is a loop around `slotTable`, and this is what says so: if the
  // two ever disagree, the picture is cut by a table nothing else believes in.
  const builder = createSlotMaskBuilder();
  const table = slotTable(1, false);
  const data = new Uint8Array(256);
  for (let byte = 0; byte < 256; byte++) data[byte] = byte;

  const mask = builder.build({ data, width: 256, height: 1, stride: 256, mode: 1, bg3Priority: false });
  for (let byte = 0; byte < 256; byte++) {
    assert.equal(mask.data[byte], table[byte], `byte ${byte} disagrees`);
  }
});

test('the buffer is reused across frames of the same shape', () => {
  // Sixty allocations a second of 114 KB is a GC pause, and a GC pause in this
  // app is an audio glitch - `scene.ts` says the same thing about its
  // raycaster.
  const builder = createSlotMaskBuilder();
  const first = builder.build(plane(4, 2, 8, 1));
  const second = builder.build(plane(4, 2, 8, 1));
  assert.equal(first.data, second.data);

  const resized = builder.build(plane(4, 4, 8, 1));
  assert.notEqual(resized.data, first.data);
  assert.equal(resized.data.length, 8 * 4);
});
