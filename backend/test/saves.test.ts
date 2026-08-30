import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { createGame } from '../src/db/games.js';
import {
  findSaveWithGame, createSave, updateSaveData, deleteSave, findSaveOwnership, nextFreeSlot
} from '../src/db/saves.js';
import { canDeleteSave } from '../src/saves/can-delete.js';

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

// --- deleting a save ---------------------------------------------------------

test('deleting removes that save and only that one', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);
  const doomed = createSave(db, { gameId: game.id, slotNumber: 1, name: 'a', data: Buffer.from([1]), screenshot: null });
  const keeper = createSave(db, { gameId: game.id, slotNumber: 2, name: 'b', data: Buffer.from([2]), screenshot: null });

  assert.equal(deleteSave(db, doomed.id), true);

  assert.equal(findSaveWithGame(db, doomed.id), null);
  assert.ok(findSaveWithGame(db, keeper.id), 'its neighbour is untouched');
});

/*
 * The route answers 404 on this, and it has to tell "there was nothing to
 * delete" from "the delete worked" - otherwise deleting the same save twice
 * reports success the second time and the list quietly disagrees with what the
 * player was just told.
 */
test('deleting something that is not there says so rather than pretending', () => {
  const db = migratedDb();
  assert.equal(deleteSave(db, 'no-such-save'), false);
});

test('ownership names both the owner and the game, and never the blob', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);
  const save = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'a', data: Buffer.alloc(900_000, 7), screenshot: null
  });

  const ownership = findSaveOwnership(db, save.id);

  assert.deepEqual(ownership, { ownerId: user.id, gameId: game.id });
  assert.equal(Object.keys(ownership!).length, 2, 'an 800KB savestate has no business in an identity check');
});

test('ownership of an unknown save is nothing, not a wrong answer', () => {
  const db = migratedDb();
  assert.equal(findSaveOwnership(db, 'no-such-save'), null);
});

test('the slot a deleted save held is not handed straight to the next one', () => {
  // Slot numbers are identity, not seating - already the documented rule, but
  // deletion is the only thing that can open a gap, so it is only now testable.
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);
  const first = createSave(db, { gameId: game.id, slotNumber: 1, name: 'a', data: Buffer.from([1]), screenshot: null });
  createSave(db, { gameId: game.id, slotNumber: 2, name: 'b', data: Buffer.from([2]), screenshot: null });

  deleteSave(db, first.id);

  assert.equal(nextFreeSlot(db, game.id), 3, 'the hole at 1 stays a hole');
});

/*
 * The guard, and the reason it takes the game id as well as the user id.
 *
 * Checking only the owner leaves this open: I own game A, I call
 * DELETE /api/games/A/saves/<a save of game B, somebody else's>, and a guard
 * asking "is A mine?" says yes. Both halves have to match, and each has its own
 * failing case here so neither can be dropped without turning a test red.
 */
test('deletion is refused for another owner and for another game', () => {
  const mine = { ownerId: 'alice', gameId: 'game-a' };

  assert.equal(canDeleteSave(mine, 'alice', 'game-a'), true);
  assert.equal(canDeleteSave(mine, 'bob', 'game-a'), false, 'not your save');
  assert.equal(canDeleteSave(mine, 'alice', 'game-b'), false, 'not this game\'s save');
  assert.equal(canDeleteSave(null, 'alice', 'game-a'), false, 'nothing to delete');
});
