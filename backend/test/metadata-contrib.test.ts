/**
 * Contributions to the shared catalogue.
 *
 * What these pin down is that a contribution cannot be lost or duplicated. The
 * link table's primary key is the guard against two players attaching the same
 * dump to two different games, and the cascade rules are what decide whether
 * deleting an account destroys the work it left behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  findGameMetadataById, insertCommunityMetadata, setCover, findCover,
  listGameMetadata, countGameMetadata
} from '../src/db/game-metadata.js';
import { findLinkByChecksum, linkChecksum } from '../src/db/metadata-links.js';

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

  const link = linkChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: user.id });

  assert.equal(link.metadataId, meta.id);
  assert.ok(link.createdAt instanceof Date);
  assert.equal(findLinkByChecksum(db, 'DEADBEEF')!.metadataId, meta.id);
  assert.equal(findLinkByChecksum(db, 'CAFEBABE'), null);
});

test('one dump cannot belong to two games', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const first = insertCommunityMetadata(db, { title: 'First', ...EMPTY }, user.id);
  const second = insertCommunityMetadata(db, { title: 'Second', ...EMPTY }, user.id);
  linkChecksum(db, { crc32: 'DEADBEEF', metadataId: first.id, contributedBy: user.id });

  // Refused by the primary key, not by an application guard someone could
  // forget to write at the next call site.
  assert.throws(
    () => linkChecksum(db, { crc32: 'DEADBEEF', metadataId: second.id, contributedBy: user.id }),
    /UNIQUE constraint failed/
  );
});

test('deleting an entry takes its links with it', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Doomed', ...EMPTY }, user.id);
  linkChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: user.id });

  db.prepare(`DELETE FROM "GameMetadata" WHERE id = ?`).run(meta.id);

  assert.equal(findLinkByChecksum(db, 'DEADBEEF'), null, 'no link pointing at nothing');
});

test('deleting an account keeps the contribution and drops only the credit', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Survivor', ...EMPTY }, user.id);
  linkChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: user.id });

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
