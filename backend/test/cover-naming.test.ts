/**
 * Naming a cover after its own bytes.
 *
 * The point of content addressing here is not deduplication, it is that
 * `immutable` becomes true instead of hoped for: replacing a cover produces a
 * different name, so no edge and no browser ever has to be told to forget one.
 * It also makes the ingestion idempotent -- an unchanged source recomputes the
 * same name and the work is skipped.
 *
 * The hash is over the SOURCE bytes, not the WebP produced from them: the WebP
 * encoder's output is only stable for as long as its version is, and a codec
 * bump would otherwise rename all 1415 covers at once.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  coverHash,
  coverFileName,
  thumbFileName,
  coverUrlOf,
  COVER_WIDTH,
  THUMB_WIDTH
} from '../src/covers/naming.js';

const BYTES = Buffer.from('the bytes of some box art', 'utf8');

test('the same bytes always give the same name', () => {
  assert.equal(coverHash(BYTES), coverHash(Buffer.from(BYTES)));
});

test('different bytes give a different name', () => {
  assert.notEqual(coverHash(BYTES), coverHash(Buffer.from('other box art', 'utf8')));
});

test('the name is hex and short enough to read in a log', () => {
  const hash = coverHash(BYTES);

  assert.match(hash, /^[0-9a-f]{16}$/);
});

test('the two renditions are one name apart', () => {
  const hash = coverHash(BYTES);

  assert.equal(coverFileName(hash), `${hash}.webp`);
  assert.equal(thumbFileName(hash), `${hash}-thumb.webp`);
});

test('the served URL is the public path, not the authenticated API', () => {
  // /api/covers/:id is behind requireAuth and cannot be cached by any edge.
  // This path is what Cloudflare is allowed to keep for a year.
  const url = coverUrlOf(coverHash(BYTES));

  assert.match(url, /^\/covers\/[0-9a-f]{16}\.webp$/);
  assert.ok(!url.includes('/api/'));
});

test('the display rendition is the width the browser already shrinks uploads to', () => {
  // frontend/src/lib/games/cover.ts caps an upload at 512; ingesting the
  // catalogue at a different width would make the grid mix two sharpnesses.
  assert.equal(COVER_WIDTH, 512);
  assert.ok(THUMB_WIDTH < COVER_WIDTH);
});
