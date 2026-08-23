/**
 * What an uploaded file actually is.
 *
 * The Content-Type is a claim made by whoever is uploading, and these bytes go
 * back out of the server to other players' browsers with a Content-Type of our
 * own. So the format is read from the file's own header, and a mismatch is
 * refused rather than trusted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageKindOf } from '../src/utils/image-kind.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP', 'latin1')
]);

test('the three formats are recognised by their header', () => {
  assert.equal(imageKindOf(PNG), 'image/png');
  assert.equal(imageKindOf(JPEG), 'image/jpeg');
  assert.equal(imageKindOf(WEBP), 'image/webp');
});

test('anything else is refused, whatever it claims to be', () => {
  assert.equal(imageKindOf(Buffer.from('<svg onload="alert(1)">', 'latin1')), null);
  assert.equal(imageKindOf(Buffer.from('GIF89a', 'latin1')), null);
  assert.equal(imageKindOf(Buffer.alloc(0)), null);
  assert.equal(imageKindOf(Buffer.from([0x89, 0x50])), null, 'a truncated header is not a format');
});

test('a RIFF container that is not WebP is not a WebP', () => {
  const wav = Buffer.concat([
    Buffer.from('RIFF', 'latin1'), Buffer.from([1, 2, 3, 4]), Buffer.from('WAVE', 'latin1')
  ]);
  assert.equal(imageKindOf(wav), null);
});
