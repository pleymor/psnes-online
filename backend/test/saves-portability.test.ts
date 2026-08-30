/**
 * Getting a player's progress out of the database and putting one back.
 *
 * Against a real migrated database, because the two things that can go wrong
 * here are both schema-shaped: `Save_gameId_slotNumber_key` is a unique index
 * that an import will hit, and `Game_userId_crc32_key` is what makes a game
 * row belong to one account and therefore what an import has to match on
 * rather than trust.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migratedDb, insertUser } from './helpers.js';
import { createGame, saveSram, findGameByChecksum, findSram } from '../src/db/games.js';
import { createSave } from '../src/db/saves.js';
import { exportableLibrary, applyImport } from '../src/db/portability.js';
import { buildArchive, parseArchive, CORE_STATE_VERSION } from '../src/saves/archive.js';

const NO_METADATA = {
  genre: null, publisher: null, developer: null, releaseDate: null,
  players: null, region: null, description: null, coverUrl: null
};

type Db = ReturnType<typeof migratedDb>;

function aGame(db: Db, userId: string, crc32: string | null = 'AABBCCDD', title = 'G') {
  return createGame(db, { title, filename: `${title}.sfc`, crc32, userId, ...NO_METADATA });
}

/* ------------------------------------------------------------------ export */

test('the export carries both kinds of save, which is the whole point of one file', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);
  saveSram(db, game.id, user.id, Buffer.from([1, 2, 3]));
  createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'a', data: Buffer.from([9, 9]), screenshot: null
  });

  const [exported] = exportableLibrary(db, user.id);

  assert.equal(exported.crc32, 'AABBCCDD');
  assert.deepEqual([...exported.sram!], [1, 2, 3], 'SRAM is the one that actually holds progress');
  assert.equal(exported.saves.length, 1);
  assert.deepEqual([...exported.saves[0].data], [9, 9]);
});

test('the export is scoped to one account, and can be narrowed to one game', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const theirs = insertUser(db);
  const a = aGame(db, mine.id, 'AAAAAAAA', 'A');
  aGame(db, mine.id, 'BBBBBBBB', 'B');
  aGame(db, theirs.id, 'CCCCCCCC', 'C');

  assert.deepEqual(exportableLibrary(db, mine.id).map(g => g.crc32).sort(), ['AAAAAAAA', 'BBBBBBBB']);
  assert.deepEqual(exportableLibrary(db, mine.id, a.id).map(g => g.crc32), ['AAAAAAAA']);
});

test('asking for somebody else\'s game exports nothing rather than their saves', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const theirs = insertUser(db);
  const hers = aGame(db, theirs.id, 'CCCCCCCC', 'C');

  assert.deepEqual(exportableLibrary(db, mine.id, hers.id), []);
});

/*
 * A game with no checksum cannot be matched back to a file on any machine, so
 * a row for it in the archive would be a row no import could ever place.
 */
test('a game with no checksum is left out, because nothing could import it', () => {
  const db = migratedDb();
  const user = insertUser(db);
  aGame(db, user.id, null, 'Unchecksummed');

  assert.deepEqual(exportableLibrary(db, user.id), []);
});

/* ------------------------------------------------------------------ import */

/** The whole journey: one account exports, another imports the same file. */
function exportedBy(db: Db, userId: string) {
  const parsed = parseArchive(JSON.parse(JSON.stringify(buildArchive(exportableLibrary(db, userId)))));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.archive;
}

test('a save moves to a second account, matched on the checksum alone', () => {
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  const game = aGame(db, from.id);
  saveSram(db, game.id, from.id, Buffer.from([4, 5, 6]));
  createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'a', data: Buffer.from([9, 9]), screenshot: null
  });

  const report = applyImport(db, to.id, exportedBy(db, from.id), { replaceSram: false });

  assert.equal(report.gamesCreated, 1, 'the second account had never seen this cartridge');
  assert.equal(report.statesImported, 1);
  assert.equal(report.sramImported, 1);

  const landed = findGameByChecksum(db, to.id, 'AABBCCDD')!;
  assert.notEqual(landed.id, game.id, 'a Game row is per-player; the file named neither');
  assert.deepEqual([...findSram(db, landed.id, to.id)!.sram], [4, 5, 6]);
  assert.deepEqual([...exportableLibrary(db, to.id)[0].saves[0].data], [9, 9]);
});

test('the timeline survives the trip, so an imported save is not dated today', () => {
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  const game = aGame(db, from.id);
  const original = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'a', data: Buffer.from([1]), screenshot: null
  });

  applyImport(db, to.id, exportedBy(db, from.id), { replaceSram: false });

  const landed = exportableLibrary(db, to.id)[0].saves[0];
  assert.equal(
    landed.createdAt.toISOString(), original.createdAt.toISOString(),
    'stamping "now" would also break the duplicate check on a second import'
  );
});

test('an import into an account that already uses the slot renumbers rather than overwrites', () => {
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  const theirs = aGame(db, from.id);
  createSave(db, {
    gameId: theirs.id, slotNumber: 1, name: 'incoming', data: Buffer.from([2]), screenshot: null
  });
  const mine = aGame(db, to.id);
  createSave(db, {
    gameId: mine.id, slotNumber: 1, name: 'mine', data: Buffer.from([1]), screenshot: null
  });

  const report = applyImport(db, to.id, exportedBy(db, from.id), { replaceSram: false });

  assert.equal(report.statesImported, 1);
  const saves = exportableLibrary(db, to.id)[0].saves;
  assert.equal(saves.length, 2, 'nothing was destroyed');
  assert.deepEqual(saves.map(s => s.slotNumber).sort(), [1, 2]);
  assert.ok(saves.some(s => s.name === 'mine'), 'and the one that was already there is still there');
});

test('importing the same file twice is not two libraries', () => {
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  const game = aGame(db, from.id);
  createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'a', data: Buffer.from([1]), screenshot: null
  });
  const archive = exportedBy(db, from.id);

  applyImport(db, to.id, archive, { replaceSram: false });
  const second = applyImport(db, to.id, archive, { replaceSram: false });

  assert.equal(second.statesImported, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(second.gamesCreated, 0);
  assert.equal(exportableLibrary(db, to.id)[0].saves.length, 1);
});

test('a battery save already in place is kept, and the player is told', () => {
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  const theirs = aGame(db, from.id);
  saveSram(db, theirs.id, from.id, Buffer.from([7, 7]));
  const mine = aGame(db, to.id);
  saveSram(db, mine.id, to.id, Buffer.from([1, 1]));

  const report = applyImport(db, to.id, exportedBy(db, from.id), { replaceSram: false });

  assert.equal(report.sramKept, 1);
  assert.equal(report.sramImported, 0);
  assert.deepEqual([...findSram(db, mine.id, to.id)!.sram], [1, 1], 'an hour of play, not overwritten');
});

test('and it is replaced when the player asked for exactly that', () => {
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  const theirs = aGame(db, from.id);
  saveSram(db, theirs.id, from.id, Buffer.from([7, 7]));
  const mine = aGame(db, to.id);
  saveSram(db, mine.id, to.id, Buffer.from([1, 1]));

  applyImport(db, to.id, exportedBy(db, from.id), { replaceSram: true });

  assert.deepEqual([...findSram(db, mine.id, to.id)!.sram], [7, 7]);
});

/*
 * `MAX_GAMES_PER_USER` is the ceiling the "add a game" route enforces. An
 * import that ignored it would be the way round it, and this is the one
 * endpoint that takes a list of two hundred games in one request.
 */
test('an import cannot walk past the games-per-account ceiling', () => {
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  for (let i = 0; i < 3; i++) {
    aGame(db, from.id, i.toString(16).padStart(8, '0').toUpperCase(), `T${i}`);
  }
  aGame(db, to.id, 'FFFFFFFF', 'already');

  const report = applyImport(db, to.id, exportedBy(db, from.id), { replaceSram: false, maxGames: 2 });

  assert.equal(report.gamesCreated, 1, 'one slot was free under the ceiling of two');
  assert.equal(report.gamesRefused, 2);
});

test('the core version the file was written with is reported back', () => {
  const db = migratedDb();
  const to = insertUser(db);
  const foreign = parseArchive({
    format: 'psnes-saves', version: 1,
    coreVersion: 'snes9x-0000000000000000000000000000000000000000',
    exportedAt: '2026-08-30T12:00:00.000Z',
    games: [{
      crc32: 'AABBCCDD', title: 'G', filename: 'g.sfc',
      sram: Buffer.from([1]).toString('base64'), sramUpdatedAt: null,
      states: [{
        name: 'a', slotNumber: 1, data: 'AAAA', screenshot: null,
        createdAt: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-19T10:00:00.000Z'
      }]
    }]
  });
  assert.equal(foreign.ok, true);
  if (!foreign.ok) return;
  assert.equal(foreign.coreMatches, false);

  const report = applyImport(db, to.id, foreign.archive, { replaceSram: false });

  assert.equal(report.statesImported, 0, 'a state from another build loads into garbage');
  assert.equal(report.sramImported, 1, 'and the battery save, which has no core version, still lands');
  assert.notEqual(foreign.archive.coreVersion, CORE_STATE_VERSION);
});
