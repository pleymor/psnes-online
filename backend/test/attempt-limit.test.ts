/**
 * The counter that makes `Pseudo#1234` survive contact with a script.
 *
 * Ten thousand discriminators is not a lot: anyone who knows a pseudonym can
 * sweep the space. This is the counterpart to that format, so its boundaries
 * are worth pinning exactly rather than approximately.
 *
 * The clock is injected for the same reason fakeStorage exists in
 * core/test/profile.test.ts: a test that had to wait out a real hour would not
 * be a test.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { AttemptLimit } from '../src/utils/attempt-limit.js';

const HOUR = 3_600_000;

/** A clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test('twenty failures pass and the twenty-first does not', () => {
  const clock = fakeClock();
  const limit = new AttemptLimit({ max: 20, windowMs: HOUR, now: clock.now });

  for (let i = 0; i < 20; i++) {
    assert.equal(limit.blocked('u1'), false, `attempt ${i + 1} should be allowed`);
    limit.recordFailure('u1');
  }

  assert.equal(limit.blocked('u1'), true, 'the twenty-first attempt is refused');
});

test('only failures count, so a player who types real handles is never blocked', () => {
  const clock = fakeClock();
  const limit = new AttemptLimit({ max: 3, windowMs: HOUR, now: clock.now });

  // A hundred successful lookups record nothing at all.
  assert.equal(limit.blocked('u1'), false);
  limit.recordFailure('u1');
  limit.recordFailure('u1');
  assert.equal(limit.blocked('u1'), false, 'two failures is below the ceiling of three');
});

test('the window slides, so the counter recovers on its own', () => {
  const clock = fakeClock();
  const limit = new AttemptLimit({ max: 2, windowMs: HOUR, now: clock.now });

  limit.recordFailure('u1');
  limit.recordFailure('u1');
  assert.equal(limit.blocked('u1'), true);

  clock.advance(HOUR - 1);
  assert.equal(limit.blocked('u1'), true, 'one millisecond short of the window, still blocked');

  clock.advance(2);
  assert.equal(limit.blocked('u1'), false, 'past the window, the old failures no longer count');
});

test('it slides rather than resetting: older failures expire one by one', () => {
  const clock = fakeClock();
  const limit = new AttemptLimit({ max: 2, windowMs: HOUR, now: clock.now });

  limit.recordFailure('u1');
  clock.advance(HOUR / 2);
  limit.recordFailure('u1');
  assert.equal(limit.blocked('u1'), true);

  // The first failure ages out; the second has half an hour left to live.
  clock.advance(HOUR / 2 + 1);
  assert.equal(limit.blocked('u1'), false, 'one live failure is below the ceiling');
});

test('accounts are counted separately', () => {
  const clock = fakeClock();
  const limit = new AttemptLimit({ max: 1, windowMs: HOUR, now: clock.now });

  limit.recordFailure('u1');

  assert.equal(limit.blocked('u1'), true);
  assert.equal(limit.blocked('u2'), false, 'one account must not lock out another');
});
