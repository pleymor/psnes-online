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
