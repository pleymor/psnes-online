/**
 * What the server will let into a room's latency setting.
 *
 * The room's delay is set by one player and lived with by both, over a socket
 * anyone signed in can reach. `room:setLatencyMode` checks the sender is the
 * creator; this is the other half - that the value itself is one the engine
 * will actually run. Without it a hand-rolled client can pin a partner at a
 * hundred frames, or at a fraction of one.
 *
 * The bounds repeat frontend/src/lib/znet/delay-control.ts by hand, the way the
 * LatencyMode type already does: the backend image ships without the frontend
 * tree. `parity` below is what notices if the two ever drift.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { parseLatencyMode } from '../src/utils/latency-mode.js';

test('the automatic loop is a setting', () => {
  assert.equal(parseLatencyMode('auto'), 'auto');
});

test('a frame count the engine will run is accepted, as a number', () => {
  assert.equal(parseLatencyMode(1), 1, 'the floor');
  assert.equal(parseLatencyMode(4), 4);
  assert.equal(parseLatencyMode(16), 16, 'the ceiling');
});

test('a client that still speaks of `low` is understood, not refused', () => {
  // `low` was the name two frames went by. A room opened by an older client
  // would otherwise have its setting silently dropped.
  assert.equal(parseLatencyMode('low'), 2);
});

test('a count outside the engine is refused rather than clamped', () => {
  // Clamping would leave the room reporting a delay nobody is running, and
  // every menu showing it would be wrong.
  for (const value of [0, -1, 17, 100, 2.5]) {
    assert.equal(parseLatencyMode(value), null, `${value} is not a setting`);
  }
});

test('anything that is not a count and not `auto` is refused', () => {
  for (const value of [null, undefined, {}, [], true, 'rollback', '']) {
    assert.equal(parseLatencyMode(value), null, `${JSON.stringify(value)} is not a setting`);
  }
});
