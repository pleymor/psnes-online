/**
 * Save thumbnails.
 *
 * The picture is stored as a data URI in the Save row's existing `screenshot`
 * column, next to an 823KB savestate - so it has to stay tiny, and the code
 * has to know what the browser actually gave it. `toDataURL('image/webp')`
 * does NOT throw when a browser cannot encode WebP: it silently returns a PNG,
 * which at these dimensions is an order of magnitude larger. Reading the
 * format back out of the URI is the only way to notice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THUMBNAIL_WIDTH,
  thumbnailSize,
  imageFormatOf
} from '../../frontend/src/lib/saves/thumbnail.js';

test('a SNES frame is reduced to the target width, keeping its shape', () => {
  // 256x224 is the SNES's usual output.
  const { width, height } = thumbnailSize(256, 224);

  assert.equal(width, THUMBNAIL_WIDTH);
  assert.equal(height, 112, '224 * 128/256');
});

test('a taller frame keeps its aspect ratio rather than being squashed to a fixed box', () => {
  const { width, height } = thumbnailSize(256, 448);

  assert.equal(width, THUMBNAIL_WIDTH);
  assert.equal(height, 224);
});

test('dimensions come back as whole pixels', () => {
  const { width, height } = thumbnailSize(256, 239); // 239 * 0.5 = 119.5

  assert.ok(Number.isInteger(width));
  assert.ok(Number.isInteger(height));
});

test('a frame already smaller than the target is not enlarged', () => {
  const { width, height } = thumbnailSize(64, 56);

  assert.equal(width, 64, 'upscaling a thumbnail buys nothing and costs bytes');
  assert.equal(height, 56);
});

test('a degenerate size does not produce a zero or negative canvas', () => {
  // A capture taken before the first frame has been drawn.
  const { width, height } = thumbnailSize(0, 0);

  assert.ok(width >= 1);
  assert.ok(height >= 1);
});

test('the format is read from the data URI, not assumed from what we asked for', () => {
  assert.equal(imageFormatOf('data:image/webp;base64,UklGRg=='), 'webp');
  assert.equal(imageFormatOf('data:image/jpeg;base64,/9j/4AAQ'), 'jpeg');
  assert.equal(imageFormatOf('data:image/png;base64,iVBORw0K'), 'png');
});

test('an unrecognisable data URI reports null rather than guessing', () => {
  assert.equal(imageFormatOf(''), null);
  assert.equal(imageFormatOf('not a data uri'), null);
  assert.equal(imageFormatOf('data:text/plain;base64,aGk='), null);
});

test('a PNG answer to a WebP request is detectable, which is the whole point', () => {
  // This is what a browser without WebP encoding returns from
  // toDataURL('image/webp', 0.6) - no error, just a different picture.
  const whatWeAskedFor = 'webp';
  const whatWeGot = imageFormatOf('data:image/png;base64,iVBORw0K');

  assert.notEqual(whatWeGot, whatWeAskedFor);
});
