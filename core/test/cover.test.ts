/**
 * Cover images, on their way from a file picker to the database.
 *
 * The server stores these as BLOBs and caps a request at 400 KB, so the
 * shrinking happens in the browser - and it is the same trap as save
 * thumbnails: canvas.toDataURL('image/webp') does NOT throw on a browser that
 * cannot encode WebP, it silently returns a PNG many times larger. Reading the
 * format back out of the result is the only way to notice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { COVER_MAX_WIDTH, MAX_COVER_BYTES, coverSize } from '../../frontend/src/lib/games/cover.js';
import { imageFormatOf, thumbnailSize, THUMBNAIL_WIDTH } from '../../frontend/src/lib/saves/thumbnail.js';

test('a large scan is brought down to the cover width, keeping its shape', () => {
  const { width, height } = coverSize(1400, 1000);

  assert.equal(width, COVER_MAX_WIDTH);
  assert.equal(height, 366, '1000 * 512/1400, rounded');
});

test('an image already smaller than the target is left alone', () => {
  // Upscaling a cover buys nothing and costs bytes.
  const { width, height } = coverSize(300, 200);

  assert.equal(width, 300);
  assert.equal(height, 200);
});

test('a degenerate source still yields at least one pixel', () => {
  // A zero-sized canvas throws, which would turn a broken file into a crash.
  const { width, height } = coverSize(0, 0);

  assert.ok(width >= 1);
  assert.ok(height >= 1);
});

test('the byte cap matches the one the server enforces', () => {
  // If these drift, the player gets a 413 from a picture the UI accepted.
  assert.equal(MAX_COVER_BYTES, 400 * 1024);
});

test('the format is read from the result, not assumed from the request', () => {
  assert.equal(imageFormatOf('data:image/png;base64,AAAA'), 'png');
  assert.equal(imageFormatOf('data:image/webp;base64,AAAA'), 'webp');
});

test('covers and thumbnails share one scaling rule at two widths', () => {
  // The two differ in their target width and nothing else, so the rule is
  // extracted rather than written twice - a second copy would be the one that
  // stops matching.
  assert.equal(coverSize(1024, 512).width, COVER_MAX_WIDTH);
  assert.equal(thumbnailSize(1024, 512).width, THUMBNAIL_WIDTH);
  assert.equal(coverSize(1024, 512).height, 256, 'the aspect ratio is kept at either width');
  assert.equal(thumbnailSize(1024, 512).height, 64);
});
