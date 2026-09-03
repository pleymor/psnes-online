/**
 * Who gets to schedule a governor slice.
 *
 * `FrameGovernor` is the only timer owner in the znet stack, and it hardcoded
 * `requestAnimationFrame`. That is not the display's clock once a headset is
 * presenting - the WebXR spec lets a user agent throttle window rAF freely -
 * so an immersive session driven by it would be a bet on browser behaviour.
 *
 * The governor keeps its one-slice-at-a-time contract: it asks for exactly one
 * callback and asks again from inside the slice. `FramePump` is the adapter
 * that lets three.js's continuous animation loop satisfy that contract, and the
 * property under test is that a frame with no slice pending does nothing rather
 * than running the previous slice twice.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createFramePump } from '../../frontend/src/lib/vr/frame-pump.js';
import { FrameGovernor } from '../../frontend/src/lib/znet/governor.js';
import type { TickSource } from '../../frontend/src/lib/znet/session.js';

class Counting implements TickSource {
  pumps = 0;
  ticks = 0;
  pump(): void { this.pumps++; }
  tick(): 'ran' | 'stalled' | 'idle' { this.ticks++; return 'ran'; }
}

test('a pump with nothing scheduled does nothing', () => {
  const pump = createFramePump();
  pump.pump();
  pump.pump();
  // No throw, and no stale callback replayed - that is the whole assertion.
  let ran = 0;
  pump.schedule(() => ran++);
  pump.pump();
  assert.equal(ran, 1);
  pump.pump();
  assert.equal(ran, 1, 'one schedule is one run, however many frames arrive');
});

test('the governor takes its slices from the pump instead of rAF', () => {
  const pump = createFramePump();
  const source = new Counting();

  // No document and no rAF: if the governor still reached for either, this
  // would throw rather than quietly pass.
  const g = globalThis as unknown as Record<string, unknown>;
  const savedDocument = g.document;
  const savedRaf = g.requestAnimationFrame;
  delete g.document;
  delete g.requestAnimationFrame;
  try {
    const governor = new FrameGovernor(source, { fps: 60, schedule: pump.schedule });
    governor.start();
    assert.equal(source.pumps, 0, 'start() schedules a slice, it does not run one');

    pump.pump();
    assert.equal(source.pumps, 1, 'the slice ran when the XR frame arrived');

    pump.pump();
    assert.equal(source.pumps, 2, 'and it rescheduled itself from inside the slice');

    governor.stop();
    pump.pump();
    assert.equal(source.pumps, 2, 'a stopped governor ignores a frame already in flight');
  } finally {
    if (savedDocument === undefined) delete g.document; else g.document = savedDocument;
    if (savedRaf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = savedRaf;
  }
});

test('presentation drives nothing: ten XR frames in one millisecond run at most one governor slice', () => {
  const pump = createFramePump();
  const source = new Counting();

  // Same technique as the test above: no document, no rAF, so a governor
  // that fell back to either would throw rather than quietly getting away
  // with it.
  const g = globalThis as unknown as Record<string, unknown>;
  const savedDocument = g.document;
  const savedRaf = g.requestAnimationFrame;
  delete g.document;
  delete g.requestAnimationFrame;
  try {
    const governor = new FrameGovernor(source, { fps: 60, schedule: pump.schedule });
    governor.start();

    // A Quest presents at 72 or 90 Hz, well above the SNES's 60.0988. Ten
    // `pump()` calls back to back, with no time passing between them, is
    // what that looks like at the seam this branch opened: the XR animation
    // loop calling `pump()` once per real display frame, far more often than
    // the governor's own clock allows a slice. `source.ticks`, not
    // `source.pumps` - the existing tests above only ever assert the latter,
    // which is "did the adapter forward the frame", not "did presentation
    // itself drive the emulator's clock", and it is the second one that
    // `webgl-renderer.ts:8`'s ONE RULE ABOVE ALL is actually about.
    for (let i = 0; i < 10; i++) pump.pump();

    assert.ok(
      source.ticks <= 1,
      `a headset's own frame rate must never run more emulator ticks than the SNES clock allows (ticks=${source.ticks})`
    );
  } finally {
    if (savedDocument === undefined) delete g.document; else g.document = savedDocument;
    if (savedRaf === undefined) delete g.requestAnimationFrame; else g.requestAnimationFrame = savedRaf;
  }
});
