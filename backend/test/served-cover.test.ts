/**
 * The two cover columns, and the seam that hides them from everyone else.
 *
 * `coverUrl` says where the bytes come from and belongs to
 * backend/metadata/snes-metadata.json, which `syncCatalogue` rewrites on every
 * refresh. `servedCoverUrl` says what a browser should ask for and belongs to
 * the ingestion. `toMetadata` collapses the pair, so the room protocol, the
 * launch options, the VR panels and the grid keep reading one `coverUrl` and
 * never learn that there are two.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers.js';
import {
  insertGameMetadataBatch,
  listGameMetadata,
  syncCatalogue,
  setServedCover,
  listCoverWork
} from '../src/db/game-metadata.js';

const LIBRETRO =
  'https://raw.githubusercontent.com/libretro-thumbnails/SNES/master/Named_Boxarts/DKC.png';

const ENTRY = {
  title: 'Donkey Kong Country', altTitle: null, genre: 'Platform', publisher: 'Nintendo',
  developer: 'Rare', releaseDate: '1994-11-21', players: '2', region: 'NTSC',
  description: null, coverUrl: LIBRETRO, crc32: null, md5: null
};

function seeded() {
  const db = migratedDb();
  insertGameMetadataBatch(db, [ENTRY]);
  return db;
}

test('a row not yet ingested still serves the URL it came with', () => {
  const db = seeded();

  assert.equal(listGameMetadata(db)[0].coverUrl, LIBRETRO);
});

test('once ingested, the row serves the local file instead', () => {
  const db = seeded();
  const id = listGameMetadata(db)[0].id;

  setServedCover(db, id, '/covers/0123456789abcdef.webp');

  assert.equal(listGameMetadata(db)[0].coverUrl, '/covers/0123456789abcdef.webp');
});

test('refreshing the catalogue does not undo the ingestion', () => {
  // The whole reason the second column exists. syncCatalogue rewrites coverUrl
  // from the shipped file by design; if that erased the served URL, one
  // catalogue refresh would re-fetch all 1415 covers.
  const db = seeded();
  const id = listGameMetadata(db)[0].id;
  setServedCover(db, id, '/covers/0123456789abcdef.webp');

  syncCatalogue(db, [{ ...ENTRY, coverUrl: LIBRETRO + '?changed' }]);

  assert.equal(listGameMetadata(db)[0].coverUrl, '/covers/0123456789abcdef.webp');
});

test('the warming pass is given the source URL, not the one being served', () => {
  // Fetching the served URL would have the server ask itself for the file it
  // is trying to create.
  const db = seeded();
  const id = listGameMetadata(db)[0].id;
  setServedCover(db, id, '/covers/0123456789abcdef.webp');

  const [work] = listCoverWork(db);

  assert.equal(work.id, id);
  assert.equal(work.coverUrl, LIBRETRO);
  assert.equal(work.servedCoverUrl, '/covers/0123456789abcdef.webp');
  assert.equal(work.hasCover, false, 'no uploaded BLOB on a catalogue row');
});
