/**
 * A whole warming pass over the catalogue.
 *
 * Real database, real codecs, real files in a temp directory; only the fetcher
 * is injected, because the point of the pass is what it writes and what it
 * records, and a mock of either would assert nothing.
 *
 * The behaviour that matters most is the one the catalogue forces: 1415 rows go
 * through here, 60 have no cover at all and libretro renames files, so a row
 * that cannot be had is counted and named rather than thrown.
 */

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { encode as encodePng } from '@jsquash/png';
import { migratedDb } from './helpers.js';
import { insertGameMetadataBatch, listGameMetadata, setCover } from '../src/db/game-metadata.js';
import { warmCovers } from '../src/covers/warm.js';
import type { Fetcher } from '../src/covers/ingest.js';

const HOST = 'https://raw.githubusercontent.com/libretro-thumbnails/SNES/master/Named_Boxarts/';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'warm-'));
  made.push(dir);
  return dir;
}

async function png(width = 64, height = 44): Promise<Buffer> {
  const data = new Uint8ClampedArray(width * height * 4).fill(180);
  return Buffer.from(await encodePng({ data, width, height, colorSpace: 'srgb' } as ImageData));
}

const entry = (title: string, coverUrl: string | null) => ({
  title, altTitle: null, genre: null, publisher: null, developer: null,
  releaseDate: null, players: null, region: null, description: null,
  coverUrl, crc32: null, md5: null
});

function serving(bodies: Record<string, Buffer>): Fetcher {
  return async (url: string) => {
    const bytes = bodies[url];
    return bytes
      ? { ok: true, status: 200, bytes }
      : { ok: false, status: 404, bytes: Buffer.alloc(0) };
  };
}

test('a catalogue row is fetched, written and pointed at the local file', async () => {
  const db = migratedDb();
  const dir = await tempDir();
  insertGameMetadataBatch(db, [entry('Chrono Trigger', HOST + 'Chrono.png')]);

  const report = await warmCovers(db, {
    dir,
    fetcher: serving({ [HOST + 'Chrono.png']: await png() })
  });

  assert.equal(report.ingested, 1);
  const served = listGameMetadata(db)[0].coverUrl!;
  assert.match(served, /^\/covers\/[0-9a-f]{16}\.webp$/);
  await fs.access(path.join(dir, path.basename(served)));
});

test('a second pass does the work once and skips thereafter', async () => {
  // What makes the pass safe to re-run, and resumable across 1415 rows.
  const db = migratedDb();
  const dir = await tempDir();
  insertGameMetadataBatch(db, [entry('Chrono Trigger', HOST + 'Chrono.png')]);
  const fetcher = serving({ [HOST + 'Chrono.png']: await png() });

  await warmCovers(db, { dir, fetcher });
  const second = await warmCovers(db, { dir, fetcher });

  assert.equal(second.ingested, 0);
  assert.equal(second.skipped, 1);
});

test('a cover the host no longer has is named in the report, and the rest go through', async () => {
  const db = migratedDb();
  const dir = await tempDir();
  insertGameMetadataBatch(db, [
    entry('Gone', HOST + 'Gone.png'),
    entry('Still There', HOST + 'Here.png')
  ]);

  const report = await warmCovers(db, {
    dir,
    fetcher: serving({ [HOST + 'Here.png']: await png() })
  });

  assert.equal(report.ingested, 1, 'the second row is not stopped by the first');
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].title, 'Gone');
});

test('a symlinked cover is followed and ingested', async () => {
  // The eighteen entries that render broken today.
  const db = migratedDb();
  const dir = await tempDir();
  insertGameMetadataBatch(db, [entry('Donkey Kong Country', HOST + 'DKC%20(Rev%201).png')]);

  const report = await warmCovers(db, {
    dir,
    fetcher: serving({
      [HOST + 'DKC%20(Rev%201).png']: Buffer.from('DKC.png', 'utf8'),
      [HOST + 'DKC.png']: await png()
    })
  });

  assert.equal(report.ingested, 1);
  assert.match(listGameMetadata(db)[0].coverUrl!, /^\/covers\//);
});

test('a row with no cover at all asks the network for nothing', async () => {
  const db = migratedDb();
  const dir = await tempDir();
  insertGameMetadataBatch(db, [entry('No Art', null)]);

  const report = await warmCovers(db, {
    dir,
    fetcher: async () => assert.fail('nothing should have been fetched')
  });

  assert.equal(report.nothing, 1);
});

test("a player's uploaded cover is converted from the database, never fetched", async () => {
  const db = migratedDb();
  const dir = await tempDir();
  insertGameMetadataBatch(db, [entry('Illustrated', HOST + 'Ignored.png')]);
  const id = listGameMetadata(db)[0].id;
  setCover(db, id, await png(), 'image/png');

  const report = await warmCovers(db, {
    dir,
    fetcher: async () => assert.fail('an uploaded cover must not be fetched')
  });

  assert.equal(report.ingested, 1);
  assert.match(listGameMetadata(db)[0].coverUrl!, /^\/covers\/[0-9a-f]{16}\.webp$/);
});

test('rebuilding redoes a row that was already served', async () => {
  const db = migratedDb();
  const dir = await tempDir();
  insertGameMetadataBatch(db, [entry('Chrono Trigger', HOST + 'Chrono.png')]);
  const fetcher = serving({ [HOST + 'Chrono.png']: await png() });
  await warmCovers(db, { dir, fetcher });

  const report = await warmCovers(db, { dir, fetcher, rebuild: true });

  assert.equal(report.ingested, 1);
  assert.equal(report.skipped, 0);
});
