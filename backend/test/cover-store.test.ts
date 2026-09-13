/**
 * Where the two renditions land on disk.
 *
 * The directory is a volume nginx serves straight from, so nothing here goes
 * through Bun at display time. It is also entirely derived - the catalogue's
 * source of truth stays the remote URL in snes-metadata.json, an upload's stays
 * the BLOB in prod.db - which is what makes `rebuild` safe and the volume not
 * worth backing up.
 */

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { storeRendition, hasCover } from '../src/covers/store.js';
import { coverFileName, thumbFileName } from '../src/covers/naming.js';

const made: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'covers-'));
  made.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of made.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const RENDITION = {
  hash: '0123456789abcdef',
  cover: Buffer.from('a webp, for the sake of argument', 'utf8'),
  thumb: Buffer.from('a smaller one', 'utf8')
};

test('both renditions are written under the names the URL promises', async () => {
  const dir = await tempDir();

  await storeRendition(dir, RENDITION);

  assert.deepEqual(
    await fs.readFile(path.join(dir, coverFileName(RENDITION.hash))),
    RENDITION.cover
  );
  assert.deepEqual(
    await fs.readFile(path.join(dir, thumbFileName(RENDITION.hash))),
    RENDITION.thumb
  );
});

test('storing returns the public URL, which is what the row will carry', async () => {
  const dir = await tempDir();

  const url = await storeRendition(dir, RENDITION);

  assert.equal(url, `/covers/${RENDITION.hash}.webp`);
});

test('a directory that does not exist yet is created', async () => {
  // First boot on a fresh volume.
  const dir = path.join(await tempDir(), 'not', 'yet');

  await storeRendition(dir, RENDITION);

  assert.ok(await hasCover(dir, RENDITION.hash));
});

test('a cover already on disk is recognised, so warming skips it', async () => {
  // What makes `warm` idempotent and resumable across 1415 rows.
  const dir = await tempDir();

  assert.equal(await hasCover(dir, RENDITION.hash), false);
  await storeRendition(dir, RENDITION);
  assert.equal(await hasCover(dir, RENDITION.hash), true);
});

test('a cover is only complete when both renditions are there', async () => {
  // A pass killed between the two writes must be redone, not skipped.
  const dir = await tempDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, coverFileName(RENDITION.hash)), RENDITION.cover);

  assert.equal(await hasCover(dir, RENDITION.hash), false);
});

test('a hash that is not a hash never becomes a path', async () => {
  // The hash reaches this function from the ingestion, but a traversal here
  // would write anywhere the process can reach.
  const dir = await tempDir();

  for (const hash of ['../escape', 'a/b', '..', '']) {
    await assert.rejects(
      () => storeRendition(dir, { ...RENDITION, hash }),
      `${hash} must be refused`
    );
  }
});
