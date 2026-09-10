/**
 * Contributions to the shared catalogue.
 *
 * What these pin down is that a contribution cannot be lost or duplicated. The
 * link table's primary key is the guard against two players attaching the same
 * dump to two different games, and the cascade rules are what decide whether
 * deleting an account destroys the work it left behind.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  findGameMetadataById, insertCommunityMetadata, updateCommunityMetadata, setCover, findCover,
  listGameMetadata, countGameMetadata, insertGameMetadataBatch
} from '../src/db/game-metadata.js';
import { findLinkByChecksum, claimChecksum } from '../src/db/metadata-links.js';

/** How many claims exist for a dump - one, or the primary key has stopped working. */
function countLinks(db: ReturnType<typeof migratedDb>, crc32: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM "GameMetadataChecksum" WHERE crc32 = ?`)
    .get(crc32) as { n: number }).n;
}

const EMPTY = {
  altTitle: null, genre: null, publisher: null, developer: null,
  releaseDate: null, players: null, region: null, description: null
};

test('a community entry is stored, attributed and findable', () => {
  const db = migratedDb();
  const user = insertUser(db);

  const created = insertCommunityMetadata(db, { title: 'Umihara Kawase', ...EMPTY }, user.id);

  assert.ok(created.id.length > 0);
  assert.equal(created.source, 'community');
  assert.equal(created.contributedBy, user.id);
  assert.equal(created.hasCover, false);
  assert.equal(findGameMetadataById(db, created.id)!.title, 'Umihara Kawase');
  assert.equal(countGameMetadata(db, 'catalogue'), 0, 'it does not pass for a shipped row');
});

test('every descriptive field is optional', () => {
  const db = migratedDb();
  const user = insertUser(db);

  // The player is asked for nothing but a title, and even that falls back to
  // the filename upstream. undefined would throw on binding, so the input type
  // is null-based throughout.
  const created = insertCommunityMetadata(db, { title: 'Bare', ...EMPTY }, user.id);

  assert.equal(created.genre, null);
  assert.equal(created.description, null);
  assert.equal(created.coverUrl, null);
});

test('a checksum links to an entry and is found again', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Rendering Ranger R2', ...EMPTY }, user.id);

  const link = claimChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: user.id });

  assert.equal(link.metadataId, meta.id);
  assert.ok(link.createdAt instanceof Date);
  assert.equal(findLinkByChecksum(db, 'DEADBEEF')!.metadataId, meta.id);
  assert.equal(findLinkByChecksum(db, 'CAFEBABE'), null);
});

test('one dump belongs to one game: a second claim replaces the first', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const first = insertCommunityMetadata(db, { title: 'First', ...EMPTY }, user.id);
  const second = insertCommunityMetadata(db, { title: 'Second', ...EMPTY }, user.id);
  claimChecksum(db, { crc32: 'DEADBEEF', metadataId: first.id, contributedBy: user.id });

  claimChecksum(db, { crc32: 'DEADBEEF', metadataId: second.id, contributedBy: user.id });

  // The primary key still holds the invariant - one row per dump - but the
  // conflict resolves to a correction instead of throwing. A dump that was
  // said to be the wrong game has to be sayable again.
  assert.equal(findLinkByChecksum(db, 'DEADBEEF')!.metadataId, second.id);
  assert.equal(countLinks(db, 'DEADBEEF'), 1, 'a correction must not leave two claims behind');
});

test('correcting a claim credits whoever corrected it', () => {
  const db = migratedDb();
  const wrote = insertUser(db);
  const fixed = insertUser(db);
  const wrong = insertCommunityMetadata(db, { title: 'Wrong', ...EMPTY }, wrote.id);
  const right = insertCommunityMetadata(db, { title: 'Right', ...EMPTY }, wrote.id);
  claimChecksum(db, { crc32: 'DEADBEEF', metadataId: wrong.id, contributedBy: wrote.id });

  const link = claimChecksum(db, { crc32: 'DEADBEEF', metadataId: right.id, contributedBy: fixed.id });

  // The claim is a live statement about the world, so the credit follows the
  // person standing behind it now, not the one who got it wrong.
  assert.equal(link.metadataId, right.id);
  assert.equal(link.contributedBy, fixed.id);
});

test('a community entry can be rewritten in place', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Typo Here', ...EMPTY, publisher: 'Wrong' }, user.id);

  const fixed = updateCommunityMetadata(db, meta.id, {
    title: 'Umihara Kawase', ...EMPTY, publisher: 'TNN', releaseDate: '1994'
  })!;

  // The id is what every link points at, so a correction must keep it: the
  // alternative is a new entry and a re-point, which loses the covers and the
  // credit already attached here.
  assert.equal(fixed.id, meta.id);
  assert.equal(fixed.title, 'Umihara Kawase');
  assert.equal(fixed.publisher, 'TNN');
  assert.equal(fixed.releaseDate, '1994');
  assert.equal(findGameMetadataById(db, meta.id)!.title, 'Umihara Kawase');
});

test('rewriting an entry clears the fields left blank', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Full', ...EMPTY, genre: 'Wrong', region: 'Wrong' }, user.id);

  updateCommunityMetadata(db, meta.id, { title: 'Full', ...EMPTY });

  // The form sends every field every time, so an emptied box means "this was
  // wrong", not "leave it alone". A merge would make a wrong value unremovable.
  assert.equal(findGameMetadataById(db, meta.id)!.genre, null);
  assert.equal(findGameMetadataById(db, meta.id)!.region, null);
});

test('a shipped catalogue row cannot be rewritten', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, [{ title: 'Shipped', crc32: 'DEADBEEF' }]);
  const shipped = listGameMetadata(db)[0];

  const refused = updateCommunityMetadata(db, shipped.id, { title: 'Vandalised', ...EMPTY });

  // The JSON refresh deletes and re-inserts every catalogue row, so an edit
  // here would survive exactly until the next deploy. Refusing says so now
  // rather than losing the work silently later.
  assert.equal(refused, null);
  assert.equal(findGameMetadataById(db, shipped.id)!.title, 'Shipped');
});

test('deleting an entry takes its links with it', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Doomed', ...EMPTY }, user.id);
  claimChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: user.id });

  db.prepare(`DELETE FROM "GameMetadata" WHERE id = ?`).run(meta.id);

  assert.equal(findLinkByChecksum(db, 'DEADBEEF'), null, 'no link pointing at nothing');
});

test('deleting an account keeps the contribution and drops only the credit', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Survivor', ...EMPTY }, user.id);
  claimChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: user.id });

  db.prepare(`DELETE FROM "User" WHERE id = ?`).run(user.id);

  // The data still serves every other player; only the attribution goes.
  assert.equal(findGameMetadataById(db, meta.id)!.contributedBy, null);
  assert.equal(findLinkByChecksum(db, 'DEADBEEF')!.contributedBy, null);
});

test('a cover survives the round trip and gets a versioned url', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Illustrated', ...EMPTY }, user.id);
  const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

  const coverUrl = setCover(db, meta.id, bytes, 'image/webp');

  const stored = findCover(db, meta.id)!;
  assert.deepEqual(stored.bytes, bytes);
  assert.equal(stored.mime, 'image/webp');

  // The query string is what lets the response be cached hard: replacing a
  // cover changes the URL, so no client is stuck with the old picture.
  assert.match(coverUrl, new RegExp(`^/api/covers/${meta.id}\\?v=\\d+$`));
  assert.equal(findGameMetadataById(db, meta.id)!.coverUrl, coverUrl);
  assert.equal(findGameMetadataById(db, meta.id)!.hasCover, true);
  assert.equal(findCover(db, 'no-such-entry'), null);
});

test('the listing still refuses to carry cover bytes once one exists', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Heavy', ...EMPTY }, user.id);
  setCover(db, meta.id, Buffer.alloc(64 * 1024, 7), 'image/png');

  const [listed] = listGameMetadata(db);

  assert.equal(listed.hasCover, true);
  assert.equal((listed as unknown as Record<string, unknown>).cover, undefined);
});
