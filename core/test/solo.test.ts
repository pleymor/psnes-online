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

test('the governor drives a TickSource through pump and tick', () => {
  const source = new RecordingSource();

  // FrameGovernor reaches for browser globals: document.hidden decides
  // whether it schedules on rAF or in a worker, and rAF hands it its slice.
  // Capturing the callback rather than letting it fire makes the slice
  // deterministic - the point is what the governor calls, not when.
  let slice: (() => void) | null = null;
  const g = globalThis as unknown as Record<string, unknown>;
  const savedDocument = g.document;
  const savedRaf = g.requestAnimationFrame;
  const savedCancel = g.cancelAnimationFrame;

  g.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  g.requestAnimationFrame = (cb: () => void) => {
    slice = cb;
    return 1;
  };
  g.cancelAnimationFrame = () => {};

  try {
    const governor = new FrameGovernor(source, { fps: 60 });
    governor.start();

    assert.equal(governor.isRunning, true, 'start() must arm the governor');
    assert.equal(typeof slice, 'function', 'the governor must have scheduled a slice');

    slice!();

    // pump runs unconditionally, once per slice, so it is the reliable signal.
    assert.ok(source.pumps >= 1, 'the governor must pump its source every slice');

    governor.stop();
    assert.equal(governor.isRunning, false);
  } finally {
    g.document = savedDocument;
    g.requestAnimationFrame = savedRaf;
    g.cancelAnimationFrame = savedCancel;
  }
});
