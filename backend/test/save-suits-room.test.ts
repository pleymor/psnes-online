/**
 * Which savestates a room will accept.
 *
 * The case worth protecting is not the obvious one. Refusing a save from
 * another game is easy; the trap is refusing a legitimate one, because each
 * player owns a separate Game row for the same ROM and so a guest's save can
 * never share the room's gameId. Comparing checksums instead of ids is the
 * whole content of this module, and these tests are what pin that down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSuitsRoom } from '../src/rooms/save-suits-room.js';

test('a save of the same dump is accepted', () => {
  assert.equal(saveSuitsRoom('DEADBEEF', 'DEADBEEF'), true);
});

test('a save of another game is refused', () => {
  // Before this guard, these bytes reached the emulator and produced a machine
  // in a state that never existed.
  assert.equal(saveSuitsRoom('DEADBEEF', 'CAFEBABE'), false);
});

test('the guest resuming their own save is not mistaken for a mismatch', () => {
  // Two Game rows, two ids, one ROM. An id comparison would have refused this,
  // which is why the checksum is the key.
  const sameRomHeldByBothPlayers = 'DEADBEEF';
  assert.equal(saveSuitsRoom(sameRomHeldByBothPlayers, sameRomHeldByBothPlayers), true);
});

test('an unknown checksum is not treated as a mismatch', () => {
  // Rows from before ROMs stayed local have no CRC32. Refusing them would break
  // something that works today to guard against something unprovable.
  assert.equal(saveSuitsRoom(undefined, 'DEADBEEF'), true);
  assert.equal(saveSuitsRoom('DEADBEEF', undefined), true);
  assert.equal(saveSuitsRoom(null, null), true);
  assert.equal(saveSuitsRoom('', 'DEADBEEF'), true);
});
