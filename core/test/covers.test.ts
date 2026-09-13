/**
 * Choosing which rendition of a cover to ask for.
 *
 * Measured on 2026-09-13: the identification list draws its matches at 40x30
 * CSS pixels and downloads the full scan to do it -- a median of 275 KB each,
 * so 5.5 MB to show twenty thumbnails. The ingestion writes a 160px rendition
 * next to every cover precisely so that list can stop doing that.
 *
 * The rule is a string rule rather than a second field on the wire, so nothing
 * in the room protocol, the launch options or the VR panels has to learn about
 * renditions. The price is that this rule and `backend/src/covers/naming.ts`
 * have to agree, which is what the last test here is for.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { thumbUrlOf } from '../../frontend/src/lib/games/cover.js';
import { coverUrlOf, thumbFileName } from '../../backend/src/covers/naming.js';

const HASH = '0123456789abcdef';

test('an ingested cover has a thumbnail beside it', () => {
  assert.equal(thumbUrlOf(`/covers/${HASH}.webp`), `/covers/${HASH}-thumb.webp`);
});

test('a cover that was never ingested is asked for as it is', () => {
  // The uploaded-cover route and any catalogue row not yet warmed have no
  // second rendition; asking for one would be a 404 where a picture was.
  for (const url of [
    '/api/covers/baedb928-b549-4463-a0fc-2a2d9a243dfc?v=1789041774505',
    'https://raw.githubusercontent.com/libretro-thumbnails/x/master/Named_Boxarts/A.png'
  ]) {
    assert.equal(thumbUrlOf(url), url);
  }
});

test('no cover at all stays no cover', () => {
  assert.equal(thumbUrlOf(null), null);
  assert.equal(thumbUrlOf(undefined), null);
  assert.equal(thumbUrlOf(''), null);
});

test('the thumbnail rule matches the one the server writes files by', () => {
  // Two spellings of the same convention, in two packages that cannot import
  // each other at runtime. If they drift, every thumbnail 404s at once.
  assert.equal(thumbUrlOf(coverUrlOf(HASH)), `/covers/${thumbFileName(HASH)}`);
});
