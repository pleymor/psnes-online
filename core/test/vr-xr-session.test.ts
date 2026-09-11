/**
 * Opening and closing an immersive session.
 *
 * Three rules, all learned from what goes wrong without them.
 *
 * `local` is asked for and always granted - `layout.ts` measures every scene
 * height from the eyes, so no floor is wanted for the scene itself, and the
 * 1.6 m eye height the floor path used to guess was wrong for a seated player
 * anyway. This does NOT stop the Quest asking which boundary to use: that
 * dialog is the system's own Guardian and no web API reaches it.
 *
 * Since 2026-09-11, `local-floor` is also asked for, but only as an OPTIONAL
 * feature, purely so `decor/floor.ts` can measure where the floor is. A
 * headset that refuses it still enters VR - the anchor does not move, three
 * still requests its own `local`, and no scene geometry becomes
 * floor-relative.
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

test('only local and the optional local-floor are asked for, nothing required', async () => {
  /*
   * `local` is guaranteed for an immersive session, and the geometry is
   * eye-relative, so it is never negotiated - it needs no fallback. Since
   * 2026-09-11, `local-floor` is negotiated too, but only as an OPTIONAL
   * feature, purely to measure the floor's height for the decor; a headset
   * that refuses it must still enter VR, so it is never required.
   */
  const session = fakeSession({ spaces: ['local'] });
  const nav = fakeNavigator(session);
  const vr = await openVrSession(() => {}, nav);

  assert.deepEqual(
    session.asked,
    ['local', 'local-floor'],
    'local for the scene, local-floor to measure - and nothing else'
  );

  const init = nav.inits[0] as
    | { requiredFeatures?: string[]; optionalFeatures?: string[] }
    | undefined;
  assert.deepEqual(
    init?.optionalFeatures,
    ['local-floor'],
    'local-floor is negotiated, but only as optional'
  );
  assert.ok(
    !init?.requiredFeatures?.length,
    'a required feature is a closed door for a headset that refuses it'
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

test('la session demande local-floor en optionnel', async () => {
  const nav = fakeNavigator(fakeSession());
  await openVrSession(() => {}, nav);
  assert.deepEqual(nav.inits[0], { optionalFeatures: ['local-floor'] });
});

test('un local-floor accordé est exposé', async () => {
  const opened = await openVrSession(
    () => {},
    fakeNavigator(fakeSession({ spaces: ['local', 'local-floor'] }))
  );
  assert.deepEqual(opened.floorSpace, { type: 'local-floor' });
});

test('un local-floor refusé laisse floorSpace nul sans barrer l_entrée', async () => {
  const opened = await openVrSession(
    () => {},
    fakeNavigator(fakeSession({ spaces: ['local'] }))
  );
  assert.equal(opened.floorSpace, null);
  assert.ok(opened.session);
});
