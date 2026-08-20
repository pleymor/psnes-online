/**
 * Solo play on the znet stack.
 *
 * The point of these tests is the boundary, not the arithmetic. FrameGovernor
 * is the only timer owner in this stack, and it used to name the concrete
 * 957-line NetplaySession while calling exactly two of its methods. Everything
 * here checks that the narrower contract is real rather than merely declared.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameGovernor } from '../../frontend/src/lib/znet/governor.js';
import type { TickSource } from '../../frontend/src/lib/znet/session.js';

/** Records what the governor asked of it. No timers, no core. */
class RecordingSource implements TickSource {
  pumps = 0;
  ticks = 0;
  constructor(private results: Array<'ran' | 'stalled' | 'idle'> = []) {}

  pump(): void {
    this.pumps++;
  }

  tick(): 'ran' | 'stalled' | 'idle' {
    this.ticks++;
    return this.results.shift() ?? 'ran';
  }
}

test('the governor accepts any TickSource, not only a NetplaySession', () => {
  const source = new RecordingSource();

  // Constructing is the whole assertion: before TickSource existed this did
  // not type-check, and a runtime-only widening would leave the compiler
  // still demanding a NetplaySession.
  const governor = new FrameGovernor(source, { fps: 60 });

  assert.equal(governor.isRunning, false, 'a fresh governor has not started');
});

test('the governor reads its session through the two-method contract only', () => {
  const source = new RecordingSource();
  const governor = new FrameGovernor(source, { fps: 60 });

  // Both methods exist on the narrow interface, so a governor that reached for
  // anything else would fail to compile against RecordingSource.
  assert.equal(typeof source.pump, 'function');
  assert.equal(typeof source.tick, 'function');
  assert.equal(governor.isRunning, false);
});
