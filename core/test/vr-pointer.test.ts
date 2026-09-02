/**
 * When a controller press counts as a click.
 *
 * This runs at the headset's refresh rate, so the naive version - "the trigger
 * is down and something is under the ray, therefore activate" - launches the
 * same game seventy-two times a second. Edge detection is the whole feature.
 *
 * The press edge is what activates, not the release. That is the VR
 * convention and it is also the honest one: there is no cursor to slip off a
 * button with, so waiting for a release only adds latency to something the
 * player has already committed to.
 *
 * The other rule is that hover is reported every tick while activation is
 * reported once, because the two are consumed differently: hover redraws a
 * panel, activation launches a game.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createPointer, sameTarget } from '../../frontend/src/lib/vr/pointer.js';
import type { Region } from '../../frontend/src/lib/vr/panel.js';

const PLAY: Region = { id: 'game:abc', x: 0, y: 0, w: 10, h: 10 };
const QUIT: Region = { id: 'quit', x: 20, y: 0, w: 10, h: 10 };
const onLibrary = { panel: 'library', region: PLAY };
const onProfile = { panel: 'profile', region: QUIT };

test('a press with nothing under the ray activates nothing', () => {
  const pointer = createPointer();
  assert.deepEqual(pointer.update(null, true), { hover: null, activated: null });
});

test('a press on a region activates it exactly once', () => {
  const pointer = createPointer();
  const down = pointer.update(onLibrary, true);
  assert.equal(down.activated?.region.id, 'game:abc');

  // Seventy-one more frames of the same held trigger.
  for (let i = 0; i < 71; i++) {
    assert.equal(pointer.update(onLibrary, true).activated, null, 'a held trigger is one click');
  }
});

test('releasing and pressing again is a second click', () => {
  const pointer = createPointer();
  assert.ok(pointer.update(onLibrary, true).activated);
  assert.equal(pointer.update(onLibrary, false).activated, null);
  assert.ok(pointer.update(onLibrary, true).activated, 'a deliberate second press must work');
});

test('hover is reported every tick, activation only on the edge', () => {
  const pointer = createPointer();
  const idle = pointer.update(onLibrary, false);
  assert.equal(idle.hover?.region.id, 'game:abc');
  assert.equal(idle.activated, null);

  const pressed = pointer.update(onLibrary, true);
  assert.equal(pressed.hover?.region.id, 'game:abc');
  assert.ok(pressed.activated);
});

test('moving the ray off a panel clears the hover', () => {
  const pointer = createPointer();
  pointer.update(onLibrary, false);
  assert.equal(pointer.update(null, false).hover, null);
});

test('a trigger held from empty space onto a button does not fire', () => {
  const pointer = createPointer();
  // Down over nothing...
  assert.equal(pointer.update(null, true).activated, null);
  // ...then dragged onto a button while still held. Nothing should launch: the
  // player pressed before they were aiming at anything.
  assert.equal(
    pointer.update(onLibrary, true).activated,
    null,
    'the edge already passed; sliding onto a button is not a press on it'
  );
});

test('the trigger has to be released before another panel can be clicked', () => {
  const pointer = createPointer();
  assert.ok(pointer.update(onLibrary, true).activated);
  assert.equal(
    pointer.update(onProfile, true).activated,
    null,
    'one press is one click, wherever the hand wanders'
  );
  pointer.update(onProfile, false);
  assert.equal(pointer.update(onProfile, true).activated?.region.id, 'quit');
});

test('sameTarget compares panel and region, not object identity', () => {
  assert.ok(sameTarget(onLibrary, { panel: 'library', region: { ...PLAY } }));
  assert.ok(!sameTarget(onLibrary, { panel: 'friends', region: PLAY }), 'the same id on two panels is two targets');
  assert.ok(!sameTarget(onLibrary, onProfile));
  assert.ok(sameTarget(null, null));
  assert.ok(!sameTarget(null, onLibrary));
});
