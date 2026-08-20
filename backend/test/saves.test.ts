import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { createGame } from '../src/db/games.js';
import { findSaveWithGame, createSave, updateSaveData } from '../src/db/saves.js';

const NO_METADATA = {
  genre: null, publisher: null, developer: null, releaseDate: null,
  players: null, region: null, description: null, coverUrl: null
};

function aGame(db: ReturnType<typeof migratedDb>, userId: string) {
  return createGame(db, {
    title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId, ...NO_METADATA
  });
}

test('createSave stamps id and both timestamps, and keeps the blob', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);

  const save = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'first', data: Buffer.from([1, 2, 3]), screenshot: null
  });

  assert.ok(save.id.length > 0);
  assert.ok(save.createdAt instanceof Date);
  assert.ok(save.updatedAt instanceof Date);
  assert.ok(Buffer.isBuffer(save.data));
  assert.deepEqual([...save.data], [1, 2, 3]);
});

test('updateSaveData replaces the blob and advances updatedAt', async () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);
  const save = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'first', data: Buffer.from([1]), screenshot: null
  });
  await new Promise(r => setTimeout(r, 5));

  updateSaveData(db, save.id, 'renamed', Buffer.from([7, 7, 7]), null);

  const read = findSaveWithGame(db, save.id)!;
  assert.equal(read.name, 'renamed');
  assert.deepEqual([...read.data], [7, 7, 7]);
  assert.ok(read.updatedAt.getTime() > save.updatedAt.getTime());
});

test('findSaveWithGame nests the owning game, so the caller can check ownership', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);
  const save = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 's', data: Buffer.from([1]), screenshot: null
  });

  const found = findSaveWithGame(db, save.id)!;

  assert.equal(found.game.id, game.id);
  assert.equal(found.game.userId, user.id);
  assert.ok(found.game.uploadedAt instanceof Date);
  assert.ok(Buffer.isBuffer(found.data));
});

test('findSaveWithGame returns null for an unknown save', () => {
  const db = migratedDb();
  assert.equal(findSaveWithGame(db, 'nope'), null);
});

test('one slot per game is enforced by the schema', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);
  createSave(db, { gameId: game.id, slotNumber: 1, name: 'a', data: Buffer.from([1]), screenshot: null });

  assert.throws(
    () => createSave(db, { gameId: game.id, slotNumber: 1, name: 'b', data: Buffer.from([2]), screenshot: null }),
    /UNIQUE/,
    'the unique index on (gameId, slotNumber) is why the handler checks before inserting'
  );
});
