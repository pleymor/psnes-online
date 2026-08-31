/**
 * The client half of carrying saves off this server and back onto it.
 *
 * The rule under test is that an import never reports success for something
 * that did not happen. The server answers with seven counts, and three of them
 * - duplicates skipped, a battery save kept, a game refused at the ceiling -
 * are cases where the file held something and the account did not gain it.
 * A summary that showed only the cheerful counts would let a player believe a
 * save arrived when it did not, and then delete the file.
 *
 * `saves-api.test.ts` next door pins the same principle for reading saves: a
 * failure has to keep its identity all the way to the sentence shown.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  exportUrl,
  parseArchiveText,
  importFailureKey,
  importSummary,
  archiveFilename,
  type ImportResponse
} from '../../frontend/src/lib/saves/portability.js';

const report = (over: Partial<ImportResponse['report']> = {}): ImportResponse['report'] => ({
  gamesCreated: 0, gamesMatched: 0, gamesRefused: 0,
  statesImported: 0, duplicates: 0, sramImported: 0, sramKept: 0,
  ...over
});

const keys = (res: ImportResponse) => importSummary(res).map(line => line.key);

/* --------------------------------------------------------------- the request */

test('the export asks for the whole library by default', () => {
  assert.equal(exportUrl({}), '/api/saves/export');
});

test('one game is the same endpoint, narrowed - not a second format', () => {
  assert.equal(exportUrl({ gameId: 'g1' }), '/api/saves/export?gameId=g1');
});

test('a game id is escaped rather than pasted into the query', () => {
  assert.ok(!exportUrl({ gameId: 'a&b=c' }).includes('a&b=c'));
});

test('thumbnails can be left behind, because a full library is mostly PNG', () => {
  assert.equal(exportUrl({ screenshots: false }), '/api/saves/export?screenshots=0');
  assert.equal(exportUrl({ screenshots: true }), '/api/saves/export');
});

test('the filename says what it is and sorts by date', () => {
  assert.equal(archiveFilename(new Date('2026-08-30T12:00:00.000Z')), 'psnes-saves-2026-08-30.json');
});

/* ---------------------------------------------------------------- the file */

test('a file that is not JSON is refused here, before it is uploaded', () => {
  const result = parseArchiveText('this is not json');

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'importNotAnArchive');
});

test('a JSON file that is not one of ours is refused too', () => {
  for (const text of ['null', '42', '[]', '{"format":"zip"}']) {
    const result = parseArchiveText(text);
    assert.equal(result.ok, false, `${text} should not be taken for an archive`);
  }
});

test('an archive passes through untouched, for the server to judge properly', () => {
  const result = parseArchiveText('{"format":"psnes-saves","version":1,"games":[]}');

  assert.equal(result.ok, true);
});

/* ------------------------------------------------------------- the failure */

test('an expired session says so, because the remedy is signing in again', () => {
  assert.equal(importFailureKey(401, undefined), 'sessionExpired');
});

/*
 * The four reasons the parser gives need four different things from the
 * player: find the right file, update the app, the file is damaged, the file
 * is too big. Collapsing them into "import failed" sends someone hunting for
 * the wrong problem.
 */
test('each refusal keeps its own remedy', () => {
  assert.equal(importFailureKey(400, 'notAnArchive'), 'importNotAnArchive');
  assert.equal(importFailureKey(400, 'unsupportedVersion'), 'importNewerVersion');
  assert.equal(importFailureKey(400, 'malformed'), 'importDamaged');
  assert.equal(importFailureKey(400, 'tooLarge'), 'importTooLarge');
});

test('an unrecognised reason falls back rather than showing a server string', () => {
  assert.equal(importFailureKey(500, undefined), 'importFailed');
  assert.equal(importFailureKey(400, 'something-new'), 'importFailed');
});

/* ------------------------------------------------------------- the summary */

test('a clean import reports what arrived', () => {
  assert.deepEqual(
    keys({ coreMatches: true, report: report({ gamesCreated: 2, statesImported: 5, sramImported: 2 }) }),
    ['importedGames', 'importedStates', 'importedSram']
  );
});

test('the counts are carried through, not just the fact', () => {
  const [line] = importSummary({ coreMatches: true, report: report({ statesImported: 5 }) });

  assert.equal(line.count, 5);
});

/*
 * The three quiet outcomes. Each is the file holding something the account did
 * not gain, and each has to be said out loud.
 */
test('savestates already present are reported as skipped, not as imported', () => {
  assert.ok(keys({ coreMatches: true, report: report({ duplicates: 3 }) }).includes('importSkippedDuplicates'));
});

test('a battery save that was kept is reported, because that one cannot be renumbered', () => {
  assert.ok(keys({ coreMatches: true, report: report({ sramKept: 1 }) }).includes('importKeptSram'));
});

test('games refused at the account ceiling are reported', () => {
  assert.ok(keys({ coreMatches: true, report: report({ gamesRefused: 4 }) }).includes('importRefusedGames'));
});

/*
 * The loudest one. A savestate from a different snes9x build loads into
 * garbage rather than failing, so it is dropped - and the player has to learn
 * that from the summary rather than from a corrupted save an hour later. It
 * leads, because everything else in the list is secondary to it.
 */
test('a file from another core build says so first', () => {
  const lines = keys({ coreMatches: false, report: report({ sramImported: 1 }) });

  assert.equal(lines[0], 'importCoreMismatch');
  assert.ok(lines.includes('importedSram'), 'the battery saves in it still arrived');
});

test('an import that changed nothing says that, rather than nothing at all', () => {
  assert.deepEqual(keys({ coreMatches: true, report: report() }), ['importedNothing']);
});
