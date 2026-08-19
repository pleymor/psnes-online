/**
 * Save slot selection.
 *
 * The slot picker used to live inside SavesManager.svelte as a reactive block
 * that wrote `selectedSlot` while reading `availableSlots`. Svelte wires that
 * pair together: choosing a slot in the <select> invalidated `availableSlots`
 * too, which re-ran the block, which overwrote the choice - so every click
 * snapped back to slot 1. The rule now lives here, as a function of the saves
 * alone, where it can be tested without a browser and cannot be re-entered by
 * the framework.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SLOT_COUNT, buildSlots, pickDefaultSlot } from '../../frontend/src/lib/saves/slots.js';

const at = (iso: string) => iso;

function save(slotNumber: number, updatedAt: string, name = `save ${slotNumber}`) {
  return { slotNumber, updatedAt: at(updatedAt), name };
}

test('an empty library offers every slot, all free', () => {
  const slots = buildSlots([]);

  assert.equal(slots.length, SLOT_COUNT);
  assert.deepEqual(slots.map(s => s.slotNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(slots.every(s => s.save === null));
});

test('slots carry their save, so the list can show what is about to be overwritten', () => {
  const third = save(3, '2026-08-18T10:00:00Z', 'Zebes');
  const slots = buildSlots([third]);

  assert.equal(slots[2].save?.name, 'Zebes');
  assert.equal(slots[0].save, null);
});

test('slots come back in slot order however the saves arrived', () => {
  const slots = buildSlots([save(7, '2026-08-18T10:00:00Z'), save(2, '2026-08-18T09:00:00Z')]);

  assert.deepEqual(slots.map(s => s.slotNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(slots[1].save?.slotNumber, 2);
  assert.equal(slots[6].save?.slotNumber, 7);
});

test('a save outside the slot range is ignored rather than widening the list', () => {
  const slots = buildSlots([save(0, '2026-08-18T10:00:00Z'), save(11, '2026-08-18T10:00:00Z')]);

  assert.equal(slots.length, SLOT_COUNT);
  assert.ok(slots.every(s => s.save === null));
});

test('with nothing saved, the default is the first slot', () => {
  assert.equal(pickDefaultSlot([]), 1);
});

test('the default is the first free slot', () => {
  const saves = [save(1, '2026-08-18T10:00:00Z'), save(2, '2026-08-18T11:00:00Z')];

  assert.equal(pickDefaultSlot(saves), 3);
});

test('a gap is filled before moving past it', () => {
  const saves = [save(1, '2026-08-18T10:00:00Z'), save(3, '2026-08-18T11:00:00Z')];

  assert.equal(pickDefaultSlot(saves), 2, 'slot 2 is free and comes first');
});

test('when every slot is taken, the default is the oldest save - the rolling one', () => {
  const saves = Array.from({ length: SLOT_COUNT }, (_, i) =>
    save(i + 1, `2026-08-${String(10 + i).padStart(2, '0')}T10:00:00Z`)
  );
  // Slot 1 is the oldest by construction; make slot 6 older still.
  saves[5] = save(6, '2026-01-01T00:00:00Z');

  assert.equal(pickDefaultSlot(saves), 6);
});

test('a full library ties on age break toward the lowest slot', () => {
  const saves = Array.from({ length: SLOT_COUNT }, (_, i) => save(i + 1, '2026-08-18T10:00:00Z'));

  assert.equal(pickDefaultSlot(saves), 1);
});

test('the default never falls outside the slot range', () => {
  const saves = Array.from({ length: SLOT_COUNT }, (_, i) => save(i + 1, '2026-08-18T10:00:00Z'));

  const picked = pickDefaultSlot(saves);
  assert.ok(picked >= 1 && picked <= SLOT_COUNT);
});

test('picking is stable: asking twice for the same library gives the same slot', () => {
  const saves = [save(1, '2026-08-18T10:00:00Z'), save(3, '2026-08-18T09:00:00Z')];

  assert.equal(pickDefaultSlot(saves), pickDefaultSlot(saves));
});
