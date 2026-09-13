/**
 * One catalogue row's cover, from a remote URL to two renditions.
 *
 * The fetcher is injected, so this asserts the decisions -- follow the symlink,
 * give up on a chain, refuse an error page, never write a broken source -- at
 * the speed of a unit test and without asking GitHub for anything.
 *
 * What it deliberately does NOT do is mock the codecs: a rendition that comes
 * back is a real WebP made by the real encoder.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { encode as encodePng } from '@jsquash/png';
import { ingestCover, type Fetcher } from '../src/covers/ingest.js';

const BOXARTS = 'https://raw.githubusercontent.com/libretro-thumbnails/SNES/master/Named_Boxarts/';

async function png(): Promise<Buffer> {
  const width = 64;
  const height = 44;
  const data = new Uint8ClampedArray(width * height * 4).fill(200);
  return Buffer.from(await encodePng({ data, width, height, colorSpace: 'srgb' } as ImageData));
}

/** A fetcher over a fixed map of URL to body, counting what was asked for. */
function serving(bodies: Record<string, Buffer>): Fetcher & { asked: string[] } {
  const asked: string[] = [];
  const fetcher = (async (url: string) => {
    asked.push(url);
    const bytes = bodies[url];
    if (!bytes) return { ok: false, status: 404, bytes: Buffer.alloc(0) };
    return { ok: true, status: 200, bytes };
  }) as Fetcher & { asked: string[] };
  fetcher.asked = asked;
  return fetcher;
}

test('a plain image is ingested in one fetch', async () => {
  const url = BOXARTS + 'Plain.png';
  const fetcher = serving({ [url]: await png() });

  const result = await ingestCover(url, fetcher);

  assert.equal(result.ok, true);
  assert.equal(fetcher.asked.length, 1);
});

test('a symlink is followed to the file it names', async () => {
  // The 18 catalogue covers that render broken today, Donkey Kong Country and
  // Super Metroid among them.
  const link = BOXARTS + encodeURIComponent('ActRaiser (USA) (Arcade).png');
  const target = BOXARTS + encodeURIComponent('ActRaiser (USA).png');
  const fetcher = serving({
    [link]: Buffer.from('ActRaiser (USA).png', 'utf8'),
    [target]: await png()
  });

  const result = await ingestCover(link, fetcher);

  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  assert.deepEqual(fetcher.asked, [link, target]);
});

test('a symlink pointing at another symlink is given up on', async () => {
  // Named_Boxarts symlinks point at real files. A chain means something we do
  // not understand, and following it is how a fetch loop starts.
  const first = BOXARTS + 'First.png';
  const second = BOXARTS + 'Second.png';
  const fetcher = serving({
    [first]: Buffer.from('Second.png', 'utf8'),
    [second]: Buffer.from('Third.png', 'utf8')
  });

  const result = await ingestCover(first, fetcher);

  assert.equal(result.ok, false);
  assert.equal(fetcher.asked.length, 2, 'the chain is not walked further');
});

test('a cover the host no longer has is a reason, not a crash', async () => {
  // 60 catalogue entries have no cover at all and libretro renames files; one
  // missing row must not stop the other 1414.
  const result = await ingestCover(BOXARTS + 'Gone.png', serving({}));

  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /404/);
});

test('an error page is refused rather than written as a cover', async () => {
  const url = BOXARTS + 'Weird.png';
  const fetcher = serving({ [url]: Buffer.from('<html>nope</html>', 'utf8') });

  const result = await ingestCover(url, fetcher);

  assert.equal(result.ok, false);
});

test('bytes that claim to be a PNG but do not decode are refused', async () => {
  const url = BOXARTS + 'Truncated.png';
  const fetcher = serving({
    [url]: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('truncated', 'utf8')
    ])
  });

  const result = await ingestCover(url, fetcher);

  assert.equal(result.ok, false, 'a decoder throw must become a reason');
});
