/**
 * Whether the button exists at all.
 *
 * The issue asked to "detect a Meta Quest user". Sniffing the user agent for
 * `OculusBrowser` would answer a question the browser answers better and would
 * rot on Meta's next release, so the door is capability only:
 * `isSessionSupported('immersive-vr')`. That also says yes on a PC with a
 * tethered headset, which is deliberate - the assumption "two controllers and
 * nothing else" only has to hold *inside* the session.
 *
 * Every failure is a false, never a throw: `isSessionSupported` rejects with a
 * SecurityError when a permissions policy blocks XR, and a library page that
 * exploded over an absent headset would be a worse bug than a missing button.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { vrAvailable } from '../../frontend/src/lib/vr/support.js';

test('no navigator at all is simply no VR', async () => {
  assert.equal(await vrAvailable(undefined), false);
});

test('a browser without navigator.xr is no VR', async () => {
  assert.equal(await vrAvailable({}), false);
});

test('a headset that answers yes opens the door', async () => {
  const asked: string[] = [];
  const nav = {
    xr: { isSessionSupported: async (mode: string) => { asked.push(mode); return true; } }
  };
  assert.equal(await vrAvailable(nav), true);
  assert.deepEqual(asked, ['immersive-vr'], 'inline-vr is not what this feature is');
});

test('a headset that answers no closes it', async () => {
  const nav = { xr: { isSessionSupported: async () => false } };
  assert.equal(await vrAvailable(nav), false);
});

test('a rejection is a false, not a throw', async () => {
  const nav = {
    xr: { isSessionSupported: async () => { throw new DOMException('blocked', 'SecurityError'); } }
  };
  assert.equal(await vrAvailable(nav), false, 'a permissions policy must not break the library page');
});
