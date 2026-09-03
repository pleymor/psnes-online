/**
 * Opening and closing an immersive session.
 *
 * Two rules, both learned from what goes wrong without them.
 *
 * Only `local` is asked for, and nothing is negotiated. Wanting a floor is
 * what makes the Quest demand a boundary before every entry, and the floor
 * bought nothing: the scene was placed from a guessed 1.6 m eye height, wrong
 * for anybody sitting down. `layout.ts` now measures from the eyes instead.
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

test('only the stationary space is asked for, and no feature is negotiated', async () => {
  /*
   * Asking for a floor is what makes the Quest demand a boundary before every
   * entry, and the floor bought nothing: the scene was placed from a guessed
   * 1.6 m eye height, wrong for anybody sitting down. `local` is guaranteed
   * for an immersive session, so there is nothing left to negotiate and no
   * degradation to fall back from.
   */
  const session = fakeSession({ spaces: ['local'] });
  const nav = fakeNavigator(session);
  const vr = await openVrSession(() => {}, nav);

  assert.deepEqual(session.asked, ['local'], 'local-floor is what triggers the boundary prompt');

  const init = nav.inits[0] as
    | { requiredFeatures?: string[]; optionalFeatures?: string[] }
    | undefined;
  assert.ok(
    !init?.optionalFeatures?.length && !init?.requiredFeatures?.length,
    'a negotiated feature is one more thing the player has to answer'
  );
  await vr.end();
});

test('a headset that only offers local is now the ordinary case', async () => {
  // It used to be the fallback. Nothing special happens here any more, and
  // that is the point of the change.
  const session = fakeSession({ spaces: ['local'] });
  const vr = await openVrSession(() => {}, fakeNavigator(session));
  assert.ok(vr.referenceSpace, 'the session came back with a space to render in');
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
