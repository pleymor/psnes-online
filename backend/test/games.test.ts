import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  listGamesWithSaveSummaries, listGamesFor, findGameById, findGameWithSaves,
  findGameByChecksum, findOtherGameWithChecksum, countGamesFor, createGame,
  updateGameChecksum, updateGameMetadata, deleteGame, findOwnedGameId,
  findOwnedGameForRoom, saveSram, findSram
} from '../src/db/games.js';
import { createSave } from '../src/db/saves.js';
import { insertCommunityMetadata } from '../src/db/game-metadata.js';
import { linkChecksum } from '../src/db/metadata-links.js';

const NO_METADATA = {
  genre: null, publisher: null, developer: null, releaseDate: null,
  players: null, region: null, description: null, coverUrl: null
};

test('createGame stamps an id and uploadedAt, and defaults the rest to null', () => {
  const db = migratedDb();
  const user = insertUser(db);

  const game = createGame(db, {
    title: 'Super Metroid', filename: 'sm.sfc', crc32: 'DEADBEEF',
    userId: user.id, ...NO_METADATA
  });

  assert.ok(game.id.length > 0);
  assert.ok(game.uploadedAt instanceof Date);
  assert.equal(game.sram, null);
  assert.equal(game.sramUpdatedAt, null);
  assert.equal(game.genre, null);
});

test('a library lists newest first, with save summaries but never save blobs', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const older = createGame(db, { title: 'A', filename: 'a.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });
  const newer = createGame(db, { title: 'B', filename: 'b.sfc', crc32: 'BBBBBBBB', userId: user.id, ...NO_METADATA });
  db.prepare(`UPDATE "Game" SET uploadedAt = ? WHERE id = ?`).run(1_000, older.id);
  db.prepare(`UPDATE "Game" SET uploadedAt = ? WHERE id = ?`).run(2_000, newer.id);
  createSave(db, { gameId: newer.id, slotNumber: 1, name: 'slot one', data: Buffer.from([1, 2, 3]), screenshot: null });

  const library = listGamesWithSaveSummaries(db, user.id);

  assert.deepEqual(library.map(g => g.title), ['B', 'A']);
  assert.equal(library[0].saves.length, 1);
  assert.equal(library[0].saves[0].name, 'slot one');
  assert.ok(!('data' in library[0].saves[0]), 'a library listing must not carry savestate blobs');
  assert.ok(library[0].saves[0].createdAt instanceof Date);
  assert.deepEqual(library[1].saves, []);
});

test('a library shows only the caller games', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const theirs = insertUser(db);
  createGame(db, { title: 'Mine', filename: 'm.sfc', crc32: 'AAAAAAAA', userId: mine.id, ...NO_METADATA });
  createGame(db, { title: 'Theirs', filename: 't.sfc', crc32: 'BBBBBBBB', userId: theirs.id, ...NO_METADATA });

  assert.equal(listGamesWithSaveSummaries(db, mine.id).length, 1);
  assert.equal(listGamesFor(db, mine.id).length, 1);
  assert.equal(countGamesFor(db, mine.id), 1);
});

test('a checksum finds a game within its owner library only', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const theirs = insertUser(db);
  createGame(db, { title: 'Mine', filename: 'm.sfc', crc32: 'DEADBEEF', userId: mine.id, ...NO_METADATA });

  assert.ok(findGameByChecksum(db, mine.id, 'DEADBEEF'));
  assert.equal(findGameByChecksum(db, theirs.id, 'DEADBEEF'), null);
});

test('re-linking a checksum detects a clash with another of your games', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const first = createGame(db, { title: 'First', filename: 'f.sfc', crc32: 'DEADBEEF', userId: user.id, ...NO_METADATA });
  const second = createGame(db, { title: 'Second', filename: 's.sfc', crc32: null, userId: user.id, ...NO_METADATA });

  assert.equal(findOtherGameWithChecksum(db, user.id, 'DEADBEEF', second.id)!.id, first.id);
  assert.equal(findOtherGameWithChecksum(db, user.id, 'DEADBEEF', first.id), null,
    'a game never clashes with itself');

  const updated = updateGameChecksum(db, second.id, 'CAFEBABE');
  assert.equal(updated.crc32, 'CAFEBABE');
});

test('metadata refresh overwrites the descriptive fields', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, { title: 'Rough Name', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });

  updateGameMetadata(db, game.id, {
    title: 'Proper Name', genre: 'Action', publisher: 'Nintendo', developer: 'Nintendo R&D1',
    releaseDate: '1994-03-19', players: '1', region: 'NTSC', description: 'A game', coverUrl: 'c.png'
  });

  const read = findGameById(db, game.id)!;
  assert.equal(read.title, 'Proper Name');
  assert.equal(read.genre, 'Action');
  assert.equal(read.coverUrl, 'c.png');
});

test('deleting a game takes its saves with it', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, { title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });
  createSave(db, { gameId: game.id, slotNumber: 1, name: 's', data: Buffer.from([1]), screenshot: null });

  deleteGame(db, game.id);

  assert.equal(findGameById(db, game.id), null);
  const saves = db.prepare(`SELECT COUNT(*) AS n FROM "Save"`).get() as { n: number };
  assert.equal(saves.n, 0, 'the server never held the ROM, but the saves must go');
});

test('findGameWithSaves nests the full saves, blobs included', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, { title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });
  createSave(db, { gameId: game.id, slotNumber: 2, name: 's', data: Buffer.from([9, 8, 7]), screenshot: null });

  const found = findGameWithSaves(db, game.id)!;

  assert.equal(found.saves.length, 1);
  assert.ok(Buffer.isBuffer(found.saves[0].data));
  assert.deepEqual([...found.saves[0].data], [9, 8, 7]);
});

test('ownership checks refuse a game that is not yours', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const theirs = insertUser(db);
  const game = createGame(db, {
    title: 'G', filename: 'g.sfc', crc32: 'DEADBEEF', userId: mine.id,
    ...NO_METADATA, coverUrl: '/covers/g.png'
  });

  assert.equal(findOwnedGameId(db, game.id, mine.id), game.id);
  assert.equal(findOwnedGameId(db, game.id, theirs.id), null);
  // What a room copies from a game: both facts, or nothing at all. A room built
  // from someone else's id gets no checksum and no cover, rather than theirs.
  assert.deepEqual(findOwnedGameForRoom(db, game.id, mine.id), {
    crc32: 'DEADBEEF', coverUrl: '/covers/g.png'
  });
  assert.equal(findOwnedGameForRoom(db, game.id, theirs.id), null);
});

test('SRAM round-trips as a Buffer and stamps its own timestamp', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, { title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });

  assert.equal(findSram(db, game.id, user.id), null, 'no SRAM yet');

  const bytes = Buffer.alloc(8192, 0x5a);
  saveSram(db, game.id, user.id, bytes);

  const read = findSram(db, game.id, user.id)!;
  assert.ok(Buffer.isBuffer(read.sram));
  assert.equal(read.sram.length, 8192);
  assert.equal(read.sram[0], 0x5a);
  assert.ok(read.sramUpdatedAt instanceof Date);
});

test('SRAM writes refuse a game that is not yours', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const theirs = insertUser(db);
  const game = createGame(db, { title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: mine.id, ...NO_METADATA });

  /*
   * And say so. The `AND userId = ?` makes this a guard as much as a write, and
   * a guard that neither throws nor returns anything let a caller answer
   * "saved" over a write that touched no row - which is how an hour of play
   * went missing once the guest could choose the game.
   */
  assert.equal(saveSram(db, game.id, theirs.id, Buffer.from([1, 2, 3])), 0,
    'a refused write has to report that it changed nothing');

  assert.equal(findSram(db, game.id, mine.id), null, 'the write must not have landed');

  assert.equal(saveSram(db, game.id, mine.id, Buffer.from([9, 9, 9])), 1,
    'and the owner\'s own write reports the row it changed');

  assert.equal(findSram(db, game.id, theirs.id), null,
    'a guest must not be able to read the host SRAM either');
});

test('a large savestate blob survives the round trip intact', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, { title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });
  // Savestates run around 823KB; check the real order of magnitude, not a toy.
  const big = Buffer.alloc(900_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 256;
  createSave(db, { gameId: game.id, slotNumber: 1, name: 'big', data: big, screenshot: null });

  const read = findGameWithSaves(db, game.id)!.saves[0];

  assert.equal(read.data.length, big.length);
  assert.ok(read.data.equals(big), 'the blob must come back byte for byte');
});

/** A community entry with only the fields a test cares about filled in. */
function contribute(db: ReturnType<typeof migratedDb>, userId: string, over: Record<string, string | null>) {
  return insertCommunityMetadata(db, {
    title: 'Untitled', altTitle: null, genre: null, publisher: null, developer: null,
    releaseDate: null, players: null, region: null, description: null, ...over
  } as Parameters<typeof insertCommunityMetadata>[1], userId);
}

test('the library resolves a game through its checksum link', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, {
    title: 'smw.sfc', filename: 'smw.sfc', crc32: 'DEADBEEF',
    userId: user.id, ...NO_METADATA
  });
  const meta = contribute(db, user.id, {
    title: 'Super Mario World', genre: 'Platform', publisher: 'Nintendo', players: '2'
  });
  linkChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: user.id });

  const [listed] = listGamesWithSaveSummaries(db, user.id);

  // Nothing was written to the Game row: the link is resolved on the way out,
  // which is why a contribution reaches players who added the ROM long ago.
  assert.equal(listed.title, 'Super Mario World');
  assert.equal(listed.genre, 'Platform');
  assert.equal(listed.players, '2');
  assert.equal(listed.metadataId, meta.id);
  assert.equal(listed.needsIdentification, false);
  assert.equal(findGameById(db, game.id)!.title, 'smw.sfc', 'the stored row is untouched');
});

test('another player with the same dump gets the same identity for free', () => {
  const db = migratedDb();
  const one = insertUser(db);
  const two = insertUser(db);
  createGame(db, { title: 'rom.sfc', filename: 'rom.sfc', crc32: 'DEADBEEF', userId: one.id, ...NO_METADATA });
  createGame(db, { title: 'copy.sfc', filename: 'copy.sfc', crc32: 'DEADBEEF', userId: two.id, ...NO_METADATA });

  const meta = contribute(db, one.id, { title: 'Rendering Ranger R2' });
  linkChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: one.id });

  const [seenByTwo] = listGamesWithSaveSummaries(db, two.id);

  assert.equal(seenByTwo.title, 'Rendering Ranger R2');
  assert.equal(seenByTwo.needsIdentification, false);
});

test('an unrecognised game reports that it needs identifying', () => {
  const db = migratedDb();
  const user = insertUser(db);
  createGame(db, { title: 'unknown.sfc', filename: 'unknown.sfc', crc32: 'CAFEBABE', userId: user.id, ...NO_METADATA });

  const [listed] = listGamesWithSaveSummaries(db, user.id);

  assert.equal(listed.needsIdentification, true);
  assert.equal(listed.metadataId, null);
});

test('a game a title match already described is not asked to be identified', () => {
  const db = migratedDb();
  const user = insertUser(db);
  createGame(db, {
    title: 'Super Metroid', filename: 'sm.sfc', crc32: 'CAFEBABE', userId: user.id,
    ...NO_METADATA, genre: 'Action'
  });

  const [listed] = listGamesWithSaveSummaries(db, user.id);

  assert.equal(listed.needsIdentification, false, 'one known field is enough to stay quiet');
});

test('a game with no checksum at all does not break the join', () => {
  const db = migratedDb();
  const user = insertUser(db);
  // Pre-local-ROM rows: LinkRom has to attach a checksum before there is
  // anything to identify, so the join cannot match and must not throw either.
  createGame(db, { title: 'Legacy', filename: 'legacy.sfc', crc32: null, userId: user.id, ...NO_METADATA });

  const [listed] = listGamesWithSaveSummaries(db, user.id);

  assert.equal(listed.metadataId, null);
  assert.equal(listed.title, 'Legacy');
});
