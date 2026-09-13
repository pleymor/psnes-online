/**
 * Turning whatever a cover host returned into the two renditions we serve.
 *
 * Real codecs, no mocks: the whole value of this step is what the bytes weigh
 * and how wide they come out, and a mock would assert neither. Measured on the
 * real Donkey Kong Country 2 scan (512x357, 309 KB PNG) on 2026-09-13:
 *
 *     512px webp q75   48.9 KB   6.3x    67ms
 *     160px webp q75    7.2 KB  43.1x    10ms
 *
 * libvips would have been ~3x faster and 6% smaller for +72 MB of Docker image,
 * against a Dockerfile that says in so many words why the native dependencies
 * were removed. Seventy seconds of encoding across the whole catalogue, once,
 * is not worth that -- and the warming pass waits on the network far longer
 * than on the codec anyway.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { encode as encodePng } from '@jsquash/png';
import { encode as encodeJpeg } from '@jsquash/jpeg';
import { decode as decodeWebp } from '@jsquash/webp';
import { renderCover } from '../src/covers/render.js';
import { coverHash, COVER_WIDTH, THUMB_WIDTH } from '../src/covers/naming.js';

/** A box-art-shaped picture with enough going on that WebP cannot cheat. */
function picture(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 7) % 256;
      data[i + 1] = (y * 5) % 256;
      data[i + 2] = ((x ^ y) * 3) % 256;
      data[i + 3] = 255;
    }
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

async function pngOf(width: number, height: number): Promise<Buffer> {
  return Buffer.from(await encodePng(picture(width, height)));
}

async function sizeOf(webp: Buffer): Promise<{ width: number; height: number }> {
  const decoded = await decodeWebp(
    webp.buffer.slice(webp.byteOffset, webp.byteOffset + webp.byteLength) as ArrayBuffer
  );
  return { width: decoded.width, height: decoded.height };
}

test('a catalogue PNG becomes two WebP renditions', async () => {
  const source = await pngOf(512, 357);

  const rendered = await renderCover(source, 'image/png');

  assert.equal((await sizeOf(rendered.cover)).width, COVER_WIDTH);
  assert.equal((await sizeOf(rendered.thumb)).width, THUMB_WIDTH);
});

test('the renditions keep the shape of the scan', async () => {
  // Box art comes both landscape (libretro, 512x357) and portrait
  // (downloadroms, 357x632). Neither may be squashed into the other, so a
  // portrait taller than it is wide must come out still portrait.
  const rendered = await renderCover(await pngOf(714, 1264), 'image/png');

  const cover = await sizeOf(rendered.cover);
  assert.equal(cover.width, COVER_WIDTH);
  assert.equal(cover.height, Math.round((1264 / 714) * COVER_WIDTH));
});

test('a scan wider than the target comes out lighter than it went in', async () => {
  const source = await pngOf(1024, 714);

  const rendered = await renderCover(source, 'image/png');

  assert.ok(
    rendered.cover.length < source.length,
    `${rendered.cover.length} should be under the ${source.length} of the source`
  );
  assert.ok(rendered.thumb.length < rendered.cover.length);
});

test('an image already narrower than the target is not blown up', async () => {
  // Upscaling invents detail and costs bytes.
  const rendered = await renderCover(await pngOf(300, 210), 'image/png');

  assert.equal((await sizeOf(rendered.cover)).width, 300);
});

test('a JPEG source is ingested too', async () => {
  // The 463 downloadroms entries are JPEG, and a plain server-side fetch does
  // reach them even though third-party resizers get a 404.
  const jpeg = Buffer.from(await encodeJpeg(picture(357, 632), { quality: 80 }));

  const rendered = await renderCover(jpeg, 'image/jpeg');

  assert.equal((await sizeOf(rendered.cover)).width, 357, 'narrower than 512, so left alone');
  assert.equal((await sizeOf(rendered.thumb)).width, THUMB_WIDTH);
});

test('the name comes from the source bytes, not from what we encoded', async () => {
  // A codec bump must not rename all 1415 covers at once.
  const source = await pngOf(512, 357);

  const rendered = await renderCover(source, 'image/png');

  assert.equal(rendered.hash, coverHash(source));
});

test('bytes that are not the image they claim to be are refused, not written', async () => {
  const notReallyAPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('and then nothing that decodes', 'utf8')
  ]);

  await assert.rejects(() => renderCover(notReallyAPng, 'image/png'));
});
