import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers.js';
import {
  countGameMetadata, listGameMetadata,
  findGameMetadataByChecksum, deleteCatalogueMetadata, insertGameMetadataBatch
} from '../src/db/game-metadata.js';

const ENTRY = {
  title: 'Super Metroid', altTitle: null, genre: 'Action', publisher: 'Nintendo',
  developer: 'Nintendo R&D1', releaseDate: '1994-03-19', players: '1',
  region: 'NTSC', description: 'A game', coverUrl: 'sm.png',
  crc32: 'D63ED5F8', md5: 'abc123'
};

test('an empty catalogue counts zero', () => {
  const db = migratedDb();
  assert.equal(countGameMetadata(db), 0);
});

test('a created entry is counted, listed and found by checksum', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, [ENTRY]);

  assert.equal(countGameMetadata(db), 1);

  const [listed] = listGameMetadata(db);
  assert.equal(listed.title, 'Super Metroid');
  assert.ok(listed.createdAt instanceof Date);

  assert.equal(findGameMetadataByChecksum(db, 'D63ED5F8')!.title, 'Super Metroid');
  assert.equal(findGameMetadataByChecksum(db, 'abc123')!.title, 'Super Metroid',
    'the lookup accepts a CRC32 or an MD5, as it always did');
  assert.equal(findGameMetadataByChecksum(db, 'nothing'), null);
});

test('optional fields survive as null rather than undefined', () => {
  const db = migratedDb();
  // The shipped JSON catalogue has holes: a missing key parses as `undefined`,
  // not `null`, and an absent key is what bun:sqlite refuses when it reaches a
  // bound parameter.
  const holey = { ...ENTRY } as Partial<typeof ENTRY>;
  delete holey.altTitle;
  delete holey.coverUrl;
  delete holey.md5;

  insertGameMetadataBatch(db, [holey as typeof ENTRY]);

  const [listed] = listGameMetadata(db);
  assert.equal(listed.altTitle, null);
  assert.equal(listed.coverUrl, null);
  assert.equal(listed.md5, null);
});

test('the batch insert loads a whole catalogue at once', () => {
  const db = migratedDb();
  const entries = Array.from({ length: 200 }, (_, i) => ({
    ...ENTRY, title: `Game ${i}`, crc32: `CRC${i}`, md5: `MD5${i}`
  }));

  const inserted = insertGameMetadataBatch(db, entries);

  assert.equal(inserted, 200);
  assert.equal(countGameMetadata(db), 200);
});

test('refreshing clears the catalogue', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, [ENTRY]);

  deleteCatalogueMetadata(db);

  assert.equal(countGameMetadata(db), 0);
});

test('a batch that fails partway through leaves nothing behind', () => {
  const db = migratedDb();
  // "title" is NOT NULL: the third row breaks the whole batch. If the batch
  // were not one transaction, the first two rows would still be sitting in
  // the table when this throws.
  const entries = [
    { ...ENTRY, crc32: 'AAA', md5: 'aaa' },
    { ...ENTRY, crc32: 'BBB', md5: 'bbb' },
    { ...ENTRY, title: null as unknown as string, crc32: 'CCC', md5: 'ccc' }
  ];

  assert.throws(() => insertGameMetadataBatch(db, entries));

  assert.equal(countGameMetadata(db), 0);
});

/** A row of the kind a player contributes, written straight in so this file stays about the catalogue. */
function insertCommunityRow(db: ReturnType<typeof migratedDb>, title: string, cover?: Buffer) {
  db.prepare(`
    INSERT INTO "GameMetadata" (id, title, source, cover, coverMime, createdAt, updatedAt)
    VALUES (?, ?, 'community', ?, ?, 0, 0)
  `).run(`c-${title}`, title, cover ?? null, cover ? 'image/webp' : null);
}

test('the catalogue count ignores what players contributed', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, [ENTRY]);
  insertCommunityRow(db, 'A game a player added');

  assert.equal(countGameMetadata(db), 2, 'without an argument, everything is counted');
  assert.equal(countGameMetadata(db, 'catalogue'), 1);
  assert.equal(countGameMetadata(db, 'community'), 1);
});

test('a batch insert is catalogue-owned by default', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, [ENTRY]);

  const [listed] = listGameMetadata(db);
  assert.equal(listed.source, 'catalogue');
  assert.equal(listed.contributedBy, null);
  assert.equal(listed.hasCover, false);
});

test('deleting the catalogue leaves the community rows standing', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, [ENTRY]);
  insertCommunityRow(db, 'A game a player added');

  // This is the whole point of the source column: refreshGameMetadata wipes
  // and reloads the JSON catalogue, and a contribution must survive it.
  deleteCatalogueMetadata(db);

  const remaining = listGameMetadata(db);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].title, 'A game a player added');
});

test('listing the catalogue does not carry the cover bytes', () => {
  const db = migratedDb();
  insertCommunityRow(db, 'With a cover', Buffer.alloc(64 * 1024, 7));

  const [listed] = listGameMetadata(db);

  // listGameMetadata is what fills metadataCache. A SELECT * would keep every
  // cover in memory and re-read them all on each invalidation, so the absence
  // of the bytes is the assertion, not an implementation detail.
  assert.equal(listed.hasCover, true, 'the presence of a cover is still reported');
  assert.equal((listed as unknown as Record<string, unknown>).cover, undefined);
});
