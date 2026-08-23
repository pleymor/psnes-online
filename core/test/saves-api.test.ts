/**
 * How the save menus read their list, and how they describe not being able to.
 *
 * The rule under test is that a failure keeps its identity. An expired session
 * and a game that is not yours are different problems with different remedies,
 * and neither is "there are no saves" - which is what an earlier version
 * showed, silently, right before overwriting one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadFailureReason,
  deleteFailureReason,
  deleteSave,
  byNewest,
  autoSaveName,
  type SaveSummary
} from '../../frontend/src/lib/saves/api.js';

function save(id: string, updatedAt: string): SaveSummary {
  return { id, name: id, slotNumber: 1, screenshot: null, createdAt: updatedAt, updatedAt };
}

test('an expired session says so, because the remedy is signing in again', () => {
  assert.equal(loadFailureReason(401), 'sessionExpired');
});

test('a forbidden game is not reported as an expired session', () => {
  assert.equal(
    loadFailureReason(403), 'notYourGame',
    'telling someone to sign in again when their session is fine sends them round a loop'
  );
});

test('anything else is a generic failure rather than a guess', () => {
  assert.equal(loadFailureReason(500), 'failedToLoadSaves');
  assert.equal(loadFailureReason(404), 'failedToLoadSaves');
  assert.equal(loadFailureReason(0), 'failedToLoadSaves');
});

test('no status maps to "there are none"', () => {
  for (const status of [400, 401, 403, 404, 418, 500, 502, 0]) {
    assert.notEqual(loadFailureReason(status), 'noSaves' as never);
  }
});

test('the list is newest first', () => {
  const ordered = byNewest([
    save('older', '2026-08-18T10:00:00.000Z'),
    save('newest', '2026-08-20T10:00:00.000Z'),
    save('middle', '2026-08-19T10:00:00.000Z')
  ]);

  assert.deepEqual(ordered.map(s => s.id), ['newest', 'middle', 'older']);
});

test('sorting does not disturb the caller array', () => {
  const original = [save('a', '2026-08-18T10:00:00.000Z'), save('b', '2026-08-20T10:00:00.000Z')];

  byNewest(original);

  assert.deepEqual(
    original.map(s => s.id), ['a', 'b'],
    'the previous version sorted in place inside the template, which mutates on every render'
  );
});

test('an automatic name carries the day and time, so two saves a minute apart differ', () => {
  const first = autoSaveName('fr-FR', new Date('2026-08-20T21:14:00Z'));
  const second = autoSaveName('fr-FR', new Date('2026-08-20T21:15:00Z'));

  assert.notEqual(first, second);
  assert.match(first, /\d/);
});

test('an automatic name follows the locale rather than a fixed format', () => {
  const when = new Date('2026-08-20T21:14:00Z');

  assert.notEqual(autoSaveName('en-US', when), autoSaveName('fr-FR', when));
});

// --- deleting ----------------------------------------------------------------

/*
 * 404 is "not yours", not a generic failure.
 *
 * The server answers 404 for both "no such save" and "not your save" on
 * purpose - distinguishing them would confirm a save id exists to somebody who
 * should not learn it. Reading it as a generic failure here would put "could
 * not delete, try again" in front of a player whose retry can never work.
 */
test('a refused deletion is reported as not yours rather than as a glitch', () => {
  assert.equal(deleteFailureReason(404), 'notYourGame');
  assert.equal(deleteFailureReason(401), 'sessionExpired');
  assert.equal(deleteFailureReason(500), 'failedToDelete');
});

/**
 * Runs `body` with `fetch` replaced, and puts the real one back afterwards.
 *
 * The two tests below exist for the one thing no pure function can catch: a
 * wrong URL or a forgotten method compiles, passes every unit test, and fails
 * only in a browser.
 */
async function withFetch(
  stub: (url: string, init?: { method?: string }) => unknown,
  body: () => Promise<void>
) {
  const real = globalThis.fetch;
  globalThis.fetch = stub as typeof globalThis.fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
  }
}

test('deleting asks the nested route, with DELETE and the session cookie', async () => {
  let seenUrl = '';
  let seenInit: { method?: string; credentials?: string } | undefined;

  await withFetch(
    (url, init) => {
      seenUrl = url;
      seenInit = init as { method?: string; credentials?: string };
      return { ok: true, status: 204 };
    },
    async () => {
      assert.deepEqual(await deleteSave('game-7', 'save-3'), { ok: true });
    }
  );

  assert.equal(seenUrl, '/api/games/game-7/saves/save-3');
  assert.equal(seenInit?.method, 'DELETE');
  assert.equal(seenInit?.credentials, 'include', 'without it the route answers 401 every time');
});

test('a network failure is a reason, not a throw at the caller', async () => {
  await withFetch(
    () => {
      throw new Error('offline');
    },
    async () => {
      assert.deepEqual(await deleteSave('g', 's'), { ok: false, reason: 'failedToDelete' });
    }
  );
});
