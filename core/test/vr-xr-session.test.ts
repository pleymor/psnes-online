/**
 * Opening and closing an immersive session.
 *
 * Two rules, both learned from what goes wrong without them.
 *
 * `local-floor` is asked for as an OPTIONAL feature, then requested as a
 * reference space with `local` as the fallback. Asking for it as a *required*
 * feature would make `requestSession` itself reject on a headset that cannot
 * offer a floor, which turns a cosmetic degradation - a scene positioned from
 * an assumed eye height - into "VR does not work on your device".
 *
 * And `onEnd` fires exactly once. The system menu ending a session, the player
 * pressing quit, and the headset being put down all arrive as the same `end`
 * event, and `end()` raises it too. A second call would stop an engine that has
 * already stopped and write the SRAM twice.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { openVrSession } from '../../frontend/src/lib/vr/xr-session.js';

function fakeSession(opts: { spaces?: string[] } = {}) {
  const allowed = new Set(opts.spaces ?? ['local-floor', 'local']);
  const listeners: Array<() => void> = [];
  const asked: string[] = [];
  let ended = 0;
  const session = {
    visibilityState: 'visible',
    asked,
    async requestReferenceSpace(type: string) {
      asked.push(type);
      if (!allowed.has(type)) throw new DOMException('unsupported', 'NotSupportedError');
      return { type };
    },
    addEventListener(_type: string, fn: () => void) { listeners.push(fn); },
    async end() { ended++; for (const fn of [...listeners]) fn(); },
    fireEnd() { for (const fn of [...listeners]) fn(); },
    get endCalls() { return ended; }
  };
  return session;
}

function fakeNavigator(session: ReturnType<typeof fakeSession>) {
  const inits: unknown[] = [];
  return {
    inits,
    xr: {
      async requestSession(mode: string, init?: unknown) {
        assert.equal(mode, 'immersive-vr');
        inits.push(init);
        return session;
      }
    }
  };
}

test('local-floor is optional, never required', async () => {
  const session = fakeSession();
  const nav = fakeNavigator(session);
  const vr = await openVrSession(() => {}, nav);

  const init = nav.inits[0] as { requiredFeatures?: string[]; optionalFeatures?: string[] };
  assert.deepEqual(init.optionalFeatures, ['local-floor']);
  assert.ok(
    !init.requiredFeatures?.includes('local-floor'),
    'requiring it turns a cosmetic degradation into a device that cannot do VR at all'
  );
  assert.equal(vr.spaceType, 'local-floor');
  await vr.end();
});

test('a headset with no floor falls back to local and says so', async () => {
  const session = fakeSession({ spaces: ['local'] });
  const vr = await openVrSession(() => {}, fakeNavigator(session));

  assert.deepEqual(session.asked, ['local-floor', 'local'], 'the good one is tried first');
  assert.equal(vr.spaceType, 'local', 'the scene needs to know it is guessing the eye height');
  await vr.end();
});

test('the system ending the session calls onEnd once', async () => {
  const session = fakeSession();
  let ends = 0;
  await openVrSession(() => ends++, fakeNavigator(session));

  session.fireEnd();
  assert.equal(ends, 1);
  session.fireEnd();
  assert.equal(ends, 1, 'a second end event must not stop an engine twice');
});

test('quitting from inside also calls onEnd exactly once', async () => {
  const session = fakeSession();
  let ends = 0;
  const vr = await openVrSession(() => ends++, fakeNavigator(session));

  await vr.end();
  assert.equal(ends, 1, 'end() raises the event too - the two paths must not both count');
  await vr.end();
  assert.equal(ends, 1, 'and calling it again is harmless');
});

test('a refused session is reported to the caller, not swallowed', async () => {
  const nav = {
    xr: {
      async requestSession() { throw new DOMException('denied', 'NotAllowedError'); }
    }
  };
  await assert.rejects(
    () => openVrSession(() => {}, nav),
    /denied/,
    'the button stays and a notice explains why; that needs the error'
  );
});

test('a browser with no xr at all rejects rather than hanging', async () => {
  await assert.rejects(() => openVrSession(() => {}, {}), /WebXR/);
});
