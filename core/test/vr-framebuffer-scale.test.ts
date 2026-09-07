/**
 * How much resolution to ask the headset for.
 *
 * three's default is `framebufferScaleFactor = 1.0`
 * (`WebXRManager.js:42`), which is not the panel's resolution: 1.0 means the
 * scale the RUNTIME recommends, and a runtime recommends with one eye on
 * performance. On a Quest the native factor is above 1, so the whole session
 * was rendering below the resolution the hardware can show - which on a
 * 256-pixel picture magnified across a 60 degree arc is exactly where it
 * hurts most.
 *
 * Everything worth testing here is a failure mode, because the cost of each
 * one is paid inside a headset. `getNativeFramebufferScaleFactor` is a static
 * on `XRWebGLLayer` that need not exist; a runtime that answers 0 or NaN would
 * produce a zero-sized framebuffer, which is a black headset indistinguishable
 * from a session that never started; and an absurd answer would render a
 * multiple of the pixels this scene needs and drop the emulator's frame rate.
 * The floor and the cap close all three.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  framebufferScale,
  MAX_FRAMEBUFFER_SCALE
} from '../../frontend/src/lib/vr/framebuffer-scale.js';

/** Stands in for the `XRWebGLLayer` global, which Bun has no reason to have. */
function layerReporting(native: unknown) {
  return { getNativeFramebufferScaleFactor: () => native as number };
}

const SESSION = {} as unknown as XRSession;

test('a runtime that can render above its recommendation is taken up on it', () => {
  // Roughly what a Quest 3 reports: the recommended scale is below native.
  assert.equal(framebufferScale(SESSION, layerReporting(1.4)), 1.4);
});

test('a runtime already recommending its native resolution changes nothing', () => {
  assert.equal(framebufferScale(SESSION, layerReporting(1)), 1);
});

test('a missing API leaves the WebXR default rather than guessing', () => {
  assert.equal(framebufferScale(SESSION, undefined), 1);
  assert.equal(framebufferScale(SESSION, {} as never), 1);
});

test('a nonsense answer never becomes a zero-sized framebuffer', () => {
  // Each of these would be a black headset, which reads as a session that
  // failed to start rather than as a bad number.
  for (const bad of [0, -1, NaN, Infinity, null, undefined, '1.4']) {
    assert.equal(framebufferScale(SESSION, layerReporting(bad)), 1, `${String(bad)} got through`);
  }
});

test('the recommendation is a floor: a native factor below it is ignored', () => {
  // A runtime whose recommendation already exceeds native - honouring 0.7
  // would throw away resolution the default was giving us for free.
  assert.equal(framebufferScale(SESSION, layerReporting(0.7)), 1);
});

test('an absurd answer is capped rather than obeyed', () => {
  assert.equal(framebufferScale(SESSION, layerReporting(8)), MAX_FRAMEBUFFER_SCALE);
  assert.ok(MAX_FRAMEBUFFER_SCALE >= 1 && MAX_FRAMEBUFFER_SCALE <= 2);
});

test('the session is passed through to the runtime that needs it', () => {
  let seen: unknown = null;
  framebufferScale(SESSION, {
    getNativeFramebufferScaleFactor: (s: XRSession) => {
      seen = s;
      return 1.2;
    }
  });
  assert.equal(seen, SESSION, 'the scale factor is per-session, not global');
});
