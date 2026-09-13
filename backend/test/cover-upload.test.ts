/**
 * A cover a player uploads, on its way to the volume nginx serves.
 *
 * The BLOB is still written and still the source of truth: it is the one image
 * in this system that cannot be fetched again from anywhere, and the files
 * beside it are derived exactly like the catalogue's are. What changes is that
 * the player's own upload stops being served from behind `requireAuth`, where
 * no edge could ever cache it.
 */

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { encode as encodePng } from '@jsquash/png';
import { migratedDb } from './helpers.js';
import { insertGameMetadataBatch, listGameMetadata, findCover } from '../src/db/game-metadata.js';
import { acceptUploadedCover } from '../src/covers/upload.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-'));
  made.push(dir);
  return dir;
}

async function png(width = 64, height = 44): Promise<Buffer> {
  const data = new Uint8ClampedArray(width * height * 4).fill(120);
  return Buffer.from(await encodePng({ data, width, height, colorSpace: 'srgb' } as ImageData));
}

function seeded() {
  const db = migratedDb();
  insertGameMetadataBatch(db, [{
    title: 'Illustrated', altTitle: null, genre: null, publisher: null, developer: null,
    releaseDate: null, players: null, region: null, description: null,
    coverUrl: null, crc32: null, md5: null
  }]);
  return { db, id: listGameMetadata(db)[0].id };
}

test('an uploaded cover is served from the covers volume', async () => {
  const { db, id } = seeded();
  const dir = await tempDir();

  const url = await acceptUploadedCover(db, id, await png(), 'image/png', dir);

  assert.match(url, /^\/covers\/[0-9a-f]{16}\.webp$/);
  await fs.access(path.join(dir, path.basename(url)));
  assert.equal(listGameMetadata(db)[0].coverUrl, url);
});

test('the uploaded bytes are still kept in the database', async () => {
  // The volume is derived and rebuildable; this BLOB is the only copy of what
  // the player chose.
  const { db, id } = seeded();
  const bytes = await png();

  await acceptUploadedCover(db, id, bytes, 'image/png', await tempDir());

  assert.deepEqual(findCover(db, id)!.bytes, bytes);
});

test('a thumbnail is written beside it, for the identification list', async () => {
  const { db, id } = seeded();
  const dir = await tempDir();

  const url = await acceptUploadedCover(db, id, await png(), 'image/png', dir);

  const hash = path.basename(url, '.webp');
  await fs.access(path.join(dir, `${hash}-thumb.webp`));
});

test('replacing a cover produces a different URL', async () => {
  // What makes `immutable` true rather than hoped for: no cache anywhere has to
  // be told to forget the old one.
  const { db, id } = seeded();
  const dir = await tempDir();

  const first = await acceptUploadedCover(db, id, await png(64, 44), 'image/png', dir);
  const second = await acceptUploadedCover(db, id, await png(80, 56), 'image/png', dir);

  assert.notEqual(first, second);
  assert.equal(listGameMetadata(db)[0].coverUrl, second);
});

test('bytes that do not decode still keep the upload, served the old way', async () => {
  // The route has already checked the header; a decode failure here means a
  // truncated file. Losing what the player sent would be the worse answer, so
  // the BLOB is kept and /api/covers serves it while the warming pass names it.
  const { db, id } = seeded();
  const broken = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('not a real png', 'utf8')
  ]);

  const url = await acceptUploadedCover(db, id, broken, 'image/png', await tempDir());

  assert.match(url, /^\/api\/covers\//);
  assert.deepEqual(findCover(db, id)!.bytes, broken);
});
