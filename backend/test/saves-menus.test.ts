/**
 * What the two save menus need from the repository.
 *
 * The slot picker is gone from the UI, so the server assigns slot numbers
 * itself, and overwriting names a save by id rather than by slot. Both of
 * those are new surfaces and both are ownership boundaries: a guest sitting
 * in someone else's room must not be able to name one of the host's saves
 * and have it overwritten.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { createGame } from '../src/db/games.js';
import { createSave, updateSaveData, nextFreeSlot, findSaveOwnerId } from '../src/db/saves.js';

const NO_METADATA = {
  genre: null, publisher: null, developer: null, releaseDate: null,
  players: null, region: null, description: null, coverUrl: null
};

function aGame(db: ReturnType<typeof migratedDb>, userId: string, crc32 = 'AAAAAAAA') {
  return createGame(db, { title: 'G', filename: 'g.sfc', crc32, userId, ...NO_METADATA });
}

function addSave(db: ReturnType<typeof migratedDb>, gameId: string, slotNumber: number) {
  return createSave(db, {
    gameId, slotNumber, name: `save ${slotNumber}`, data: Buffer.from([slotNumber]), screenshot: null
  });
}

test('the first save of a game takes slot 1', () => {
  const db = migratedDb();
  const game = aGame(db, insertUser(db).id);

  assert.equal(nextFreeSlot(db, game.id), 1);
});

test('slots keep climbing past ten, because the ten-slot cap was the old UI, not the schema', () => {
  const db = migratedDb();
  const game = aGame(db, insertUser(db).id);
  for (let i = 1; i <= 12; i++) addSave(db, game.id, i);

  assert.equal(nextFreeSlot(db, game.id), 13);
});

test('a gap is not reused: slot numbers are identity, not seating', () => {
  const db = migratedDb();
  const game = aGame(db, insertUser(db).id);
  addSave(db, game.id, 1);
  addSave(db, game.id, 2);
  db.prepare(`DELETE FROM "Save" WHERE slotNumber = 1 AND gameId = ?`).run(game.id);

  assert.equal(
    nextFreeSlot(db, game.id), 3,
    'reusing 1 would make a deleted save and a new one share an identity in anyone reading old logs'
  );
});

test('slots are counted per game, not globally', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const first = aGame(db, user.id, 'AAAAAAAA');
  const second = aGame(db, user.id, 'BBBBBBBB');
  addSave(db, first.id, 1);
  addSave(db, first.id, 2);

  assert.equal(nextFreeSlot(db, second.id), 1);
});

test('the owner of a save is the owner of its game', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const game = aGame(db, mine.id);
  const save = addSave(db, game.id, 1);

  assert.equal(findSaveOwnerId(db, save.id), mine.id);
});

test('an unknown save has no owner rather than a wrong one', () => {
  const db = migratedDb();

  assert.equal(findSaveOwnerId(db, 'no-such-save'), null);
});

test('finding the owner does not drag the savestate blob along', () => {
  const db = migratedDb();
  const game = aGame(db, insertUser(db).id);
  // A real savestate is over 800KB. Checking who owns a save must not read it:
  // the overwrite path calls this on every attempt.
  const save = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'big', data: Buffer.alloc(900_000), screenshot: null
  });

  const result = findSaveOwnerId(db, save.id) as unknown;

  assert.equal(typeof result, 'string', 'a plain owner id, not a row carrying data');
});

test('overwriting replaces the blob, the name and the thumbnail together', async () => {
  const db = migratedDb();
  const game = aGame(db, insertUser(db).id);
  const save = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'before', data: Buffer.from([1]), screenshot: 'data:image/webp;base64,AAAA'
  });
  await new Promise(r => setTimeout(r, 5));

  updateSaveData(db, save.id, 'after', Buffer.from([9, 9]), 'data:image/webp;base64,BBBB');

  const row = db.prepare(`SELECT name, data, screenshot, updatedAt FROM "Save" WHERE id = ?`)
    .get(save.id) as { name: string; data: Buffer; screenshot: string | null; updatedAt: number };
  assert.equal(row.name, 'after');
  assert.deepEqual([...row.data], [9, 9]);
  assert.equal(row.screenshot, 'data:image/webp;base64,BBBB');
  assert.ok(row.updatedAt > save.updatedAt.getTime());
});

test('overwriting with no new thumbnail clears the old one rather than keeping a stale picture', () => {
  const db = migratedDb();
  const game = aGame(db, insertUser(db).id);
  const save = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'n', data: Buffer.from([1]), screenshot: 'data:image/webp;base64,AAAA'
  });

  updateSaveData(db, save.id, 'n', Buffer.from([2]), null);

  const row = db.prepare(`SELECT screenshot FROM "Save" WHERE id = ?`)
    .get(save.id) as { screenshot: string | null };
  assert.equal(
    row.screenshot, null,
    'a thumbnail of a moment that has been overwritten is worse than none'
  );
});
