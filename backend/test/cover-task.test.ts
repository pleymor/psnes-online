/**
 * What the warming pass decides to do with one catalogue row.
 *
 * Two columns, and the reason they are two: `syncCatalogue` rewrites `coverUrl`
 * from snes-metadata.json every time the catalogue is refreshed. If the
 * ingestion wrote its result there, one refresh would silently undo all 1415
 * conversions and the next pass would re-fetch the lot. `servedCoverUrl` is
 * ours; `coverUrl` stays the file's.
 *
 * An uploaded cover outranks a catalogue URL: a player who went and found a
 * better scan meant it.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { coverTaskFor } from '../src/covers/task.js';

const LIBRETRO =
  'https://raw.githubusercontent.com/libretro-thumbnails/SNES/master/Named_Boxarts/A.png';

const row = (over: Partial<Parameters<typeof coverTaskFor>[0]> = {}) => ({
  coverUrl: null,
  servedCoverUrl: null,
  hasCover: false,
  ...over
});

test('a catalogue row with a remote cover is fetched', () => {
  const task = coverTaskFor(row({ coverUrl: LIBRETRO }), { rebuild: false });

  assert.deepEqual(task, { do: 'fetch', url: LIBRETRO });
});

test('a row already served is left alone', () => {
  const task = coverTaskFor(
    row({ coverUrl: LIBRETRO, servedCoverUrl: '/covers/0123456789abcdef.webp' }),
    { rebuild: false }
  );

  assert.equal(task.do, 'skip');
});

test('rebuilding does the work again on a row already served', () => {
  const task = coverTaskFor(
    row({ coverUrl: LIBRETRO, servedCoverUrl: '/covers/0123456789abcdef.webp' }),
    { rebuild: true }
  );

  assert.deepEqual(task, { do: 'fetch', url: LIBRETRO });
});

test("a player's uploaded cover is converted from the database, not fetched", () => {
  // The BLOB is the only copy of what that player chose, and it stays the
  // source of truth; the file on the volume is derived from it.
  const task = coverTaskFor(row({ hasCover: true, coverUrl: LIBRETRO }), { rebuild: false });

  assert.deepEqual(task, { do: 'upload' });
});

test('a row with nothing to show asks for nothing', () => {
  // Sixty catalogue entries have no cover at all.
  const task = coverTaskFor(row(), { rebuild: false });

  assert.equal(task.do, 'nothing');
});

test('a stale uploaded-cover URL with no bytes behind it is not fetched', () => {
  // /api/covers/<id> is our own route: fetching it would have the server ask
  // itself for a cover it just said it does not have.
  const task = coverTaskFor(
    row({ coverUrl: '/api/covers/baedb928-b549-4463-a0fc-2a2d9a243dfc?v=1789041774505' }),
    { rebuild: false }
  );

  assert.equal(task.do, 'nothing');
});

test('only an absolute http URL is ever fetched', () => {
  for (const coverUrl of ['/covers/0123456789abcdef.webp', 'ftp://x/y.png', 'javascript:alert(1)']) {
    assert.equal(coverTaskFor(row({ coverUrl }), { rebuild: false }).do, 'nothing', coverUrl);
  }
});
