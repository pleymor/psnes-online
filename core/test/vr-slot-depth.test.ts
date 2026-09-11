/**
 * The preset, turned into what the stack of planes actually reads.
 *
 * `slot-depth.ts` used to hold a second table of distances beside
 * `relief-preset.ts`'s. They agreed by luck, and the first preset a player
 * wrote through the panel would have ended that silently - the panel showing
 * one number, the picture standing at another. The table is gone; the module
 * is the conversion from metres per slot KEY to metres per slot INDEX, and
 * nothing here decides a distance any more.
 *
 * So what is asserted is not that 0.15 is right - none of those numbers is
 * measured, `relief-preset.ts` says so the way `layout.ts` says it about the
 * room. It is the two things a wrong number cannot be allowed to become: an
 * index that does not line up with the mask the shader reads, and a value that
 * reaches `mesh.position.z` and takes a plane out of the world.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { slotDepths } from '../../frontend/src/lib/vr/slot-depth.js';
import {
  DEFAULT_RELIEF,
  RELIEF_DISTANCES,
  type ReliefPreset
} from '../../frontend/src/lib/vr/relief-preset.js';
import { VR_SLOT_KEYS } from '../../frontend/src/lib/vr/layer-map.js';

type Key = (typeof VR_SLOT_KEYS)[number];

const at = (depths: number[], key: Key) => depths[VR_SLOT_KEYS.indexOf(key)];

/*
 * The shipped preset with the strength turned up.
 *
 * The default ships at zero strength, so every slot resolves to the glass and
 * nothing below would have anything to compare. What these tests are about is
 * the ORDER the ladder puts the layers in, which only exists once a player has
 * asked for relief - so they ask for it.
 */
const ON: ReliefPreset = { ...DEFAULT_RELIEF, spacing: 1 };

/** The shipped preset with a few slots moved, and optionally a strength. */
function preset(over: Partial<Record<Key, number>> = {}, spacing = 1): ReliefPreset {
  return { spacing, slots: { ...DEFAULT_RELIEF.slots, ...over } };
}

test('the answer is one offset per slot, in the order the mask is written in', () => {
  // The mask holds VR_SLOT_KEYS indices and the plane drawing slot i reads
  // entry i. A different length or a different order is a picture whose layers
  // are at each other's distances, which looks like the depths being wrong
  // rather than like an index being wrong.
  // At full strength a slot's depth IS its rung, so a misplaced entry shows up
  // as a mismatched number rather than as ten zeroes agreeing with each other.
  const depths = slotDepths(ON);
  assert.equal(depths.length, VR_SLOT_KEYS.length);
  for (const [index, key] of VR_SLOT_KEYS.entries()) {
    assert.equal(depths[index], DEFAULT_RELIEF.slots[key], `${key} is not at index ${index}`);
  }
});

test('called with nothing, it is the shipped preset', () => {
  // The screen is built when the session opens and the game is chosen
  // afterwards, so there is a window in which no preset has been read yet.
  assert.deepEqual(slotDepths(), slotDepths(DEFAULT_RELIEF));
});

test('the shipped default is flat, so no game changes on its own', () => {
  /*
   * Relief is a taste, not a correction - nobody's SNES had it. A picture that
   * quietly stopped being flat would be a change made on the player's behalf,
   * so the strength ships at its zero rung and every slot resolves to the
   * glass until someone turns it up.
   *
   * The distances underneath are NOT zeroed with it, which is what the next
   * test rests on: one press on the strength has to give the whole diorama,
   * correctly proportioned, rather than a player building ten rows by hand
   * before seeing anything.
   */
  for (const depth of slotDepths()) assert.equal(depth, 0);
  assert.ok(
    VR_SLOT_KEYS.some((key) => DEFAULT_RELIEF.slots[key]! > 0),
    'the ladder must survive underneath the zero strength'
  );
});

test('turned up, the stack runs from the backdrop out to the sprites', () => {
  const depths = slotDepths(ON);
  assert.equal(at(depths, 'backdrop'), 0);
  assert.ok(at(depths, 'bg3.lo') > at(depths, 'backdrop'));
  assert.ok(at(depths, 'bg2.lo') > at(depths, 'bg3.lo'));
  assert.ok(at(depths, 'bg1.lo') > at(depths, 'bg2.lo'));
  assert.ok(at(depths, 'sprite') > at(depths, 'bg1.lo'));
});

test('a status bar is painted on the glass, not floated in front of it', () => {
  /*
   * BG3's high half is the one slot that deliberately breaks the order above.
   * A game that sets BG3Priority is using it as a HUD, and a HUD given a
   * distance does two bad things at once: it slides across the picture as the
   * head moves, and - because a slot is only drawn where it won the pixel - it
   * cuts a glyph-shaped hole through everything behind it.
   */
  const depths = slotDepths(ON);
  assert.equal(at(depths, 'bg3.hi'), 0);
  assert.ok(at(depths, 'bg3.lo') > 0, 'the clouds and the status bar must not share a distance');
});

test('the two halves of one background stay at one distance', () => {
  // High and low are two passes over the same scrolling surface. Splitting
  // them would tear one plane in half along whatever the artist gave priority
  // to. BG3 is the exception above, and only because the hardware flag says so.
  const depths = slotDepths(ON);
  assert.equal(at(depths, 'bg1.hi'), at(depths, 'bg1.lo'));
  assert.equal(at(depths, 'bg2.hi'), at(depths, 'bg2.lo'));
  assert.equal(at(depths, 'bg4.hi'), at(depths, 'bg4.lo'));
});

test('a slot the player moved replaces one entry and leaves the rest alone', () => {
  const depths = slotDepths(preset({ 'bg2.lo': 0.26 }));
  assert.equal(at(depths, 'bg2.lo'), 0.26);
  assert.equal(at(depths, 'bg1.lo'), DEFAULT_RELIEF.slots['bg1.lo']);
});

test('the strength multiplies everything, and zero is the relief turned off', () => {
  const half = slotDepths(preset({}, 0.5));
  assert.equal(at(half, 'sprite'), (DEFAULT_RELIEF.slots.sprite as number) * 0.5);

  // Every plane on the glass. They do not fight: a pixel is drawn by exactly
  // the one plane whose slot won it, and the other nine discard it, so
  // coincident planes are a flat picture rather than a flickering one.
  const off = slotDepths(preset({}, 0));
  assert.ok(off.every((depth) => depth === 0));
});

test('the strength reaches a slot the player moved too', () => {
  const depths = slotDepths(preset({ sprite: 0.3 }, 0.5));
  assert.equal(at(depths, 'sprite'), 0.15);
});

test('nothing goes behind the back plane', () => {
  /*
   * There is no rung below zero, and that is not an oversight: a negative
   * offset would put a layer behind the backdrop, inverting the order the PPU
   * itself composited in - the sky in front of the ground, with no setting of
   * the other nine slots able to put it back. This used to be allowed here,
   * back when this module had its own table and the panel could not reach it.
   */
  assert.ok(RELIEF_DISTANCES.every((rung) => rung >= 0));
  assert.ok(slotDepths().every((depth) => depth >= 0));

  // And a negative strength, which only a hand-built preset can carry, lands
  // the whole stack on the glass instead of turning it inside out.
  assert.ok(slotDepths(preset({}, -2)).every((depth) => depth === 0));
});

test('a non-finite value lands on the glass rather than out of the world', () => {
  /*
   * NaN reaches `mesh.position.z` and takes the plane's whole world matrix
   * with it, so the layer vanishes - and an invisible layer inside a headset
   * looks like the game not drawing it, which is a long way from a bad number
   * in a preset. Zero is the safe mistake: a pixel that did not move.
   */
  for (const bad of [NaN, Infinity, -Infinity]) {
    const depths = slotDepths(preset({ sprite: bad }));
    assert.equal(at(depths, 'sprite'), 0, `${bad} got through`);
  }
  assert.ok(slotDepths(preset({}, NaN)).every((depth) => depth === 0));
});
