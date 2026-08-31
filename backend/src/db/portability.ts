/**
 * Reading a player's progress out, and writing somebody's file back in.
 *
 * The queries are here rather than in `db/games.ts` because they answer a
 * different question from the rest of that file: not "what does this player's
 * library look like" but "what would have to travel for this player to carry
 * their progress to another machine". Both kinds of save travel - the
 * savestates in `Save`, and the battery SRAM on `Game`, which is the one that
 * actually holds in-game progress and the one that would be forgotten.
 *
 * The policy this applies lives in `saves/import-plan.ts`, tested on its own.
 * What is here is the part that needs a real database: matching on the
 * checksum, holding the ceiling, and doing the whole thing in one transaction.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import { MAX_GAMES_PER_USER } from './games.js';
import type { ExportableGame, SaveArchive } from '../saves/archive.js';
import { planGameImport, type ExistingGameState } from '../saves/import-plan.js';

/* ------------------------------------------------------------------ export */

interface ExportRow {
  id: string;
  crc32: string;
  title: string;
  filename: string;
  sram: Buffer | null;
  sramUpdatedAt: number | null;
}

/**
 * Everything of this player's that could be carried to another machine.
 *
 * Games with no checksum are left out, and that is not an oversight: the
 * checksum is the only thing tying a row to a file on somebody's disk, so a
 * row without one is a row no import could ever place. Exporting it would put
 * an unplaceable entry in the file and a confusing line in the report.
 *
 * `gameId` narrows the export to one game - "here, take my finished file" -
 * and is still filtered by `userId`, so naming somebody else's row exports
 * nothing rather than their saves.
 */
export function exportableLibrary(
  db: Database,
  userId: string,
  gameId?: string
): ExportableGame[] {
  const rows = (gameId
    ? db.prepare(
        `SELECT id, crc32, title, filename, sram, sramUpdatedAt
         FROM "Game" WHERE userId = ? AND id = ? AND crc32 IS NOT NULL`
      ).all(userId, gameId)
    : db.prepare(
        `SELECT id, crc32, title, filename, sram, sramUpdatedAt
         FROM "Game" WHERE userId = ? AND crc32 IS NOT NULL ORDER BY title`
      ).all(userId)) as ExportRow[];

  const saves = db.prepare(
    `SELECT name, slotNumber, data, screenshot, createdAt, updatedAt
     FROM "Save" WHERE gameId = ? ORDER BY slotNumber`
  );

  return rows.map(row => ({
    crc32: row.crc32,
    title: row.title,
    filename: row.filename,
    sram: row.sram,
    sramUpdatedAt: row.sramUpdatedAt === null ? null : new Date(row.sramUpdatedAt),
    saves: (saves.all(row.id) as {
      name: string; slotNumber: number; data: Buffer;
      screenshot: string | null; createdAt: number; updatedAt: number;
    }[]).map(save => ({
      name: save.name,
      slotNumber: save.slotNumber,
      data: save.data,
      screenshot: save.screenshot,
      createdAt: new Date(save.createdAt),
      updatedAt: new Date(save.updatedAt)
    }))
  }));
}

/* ------------------------------------------------------------------ import */

export interface ImportOptions {
  replaceSram: boolean;
  /** Overridable so the ceiling itself can be tested without inserting a hundred rows. */
  maxGames?: number;
}

/**
 * What the import did, in the terms the player needs to hear it in.
 *
 * Every count here is something the UI says out loud. `duplicates`, `sramKept`
 * and `gamesRefused` in particular: they are the cases where the file
 * contained something and the account did not gain it, and a silent zero
 * against those would let a player believe a save arrived when it did not.
 */
export interface ImportReport {
  gamesCreated: number;
  gamesMatched: number;
  gamesRefused: number;
  statesImported: number;
  duplicates: number;
  sramImported: number;
  sramKept: number;
}

function existingStateOf(db: Database, gameId: string): ExistingGameState {
  const saves = db.prepare(
    `SELECT name, slotNumber, createdAt FROM "Save" WHERE gameId = ?`
  ).all(gameId) as { name: string; slotNumber: number; createdAt: number }[];
  const row = db.prepare(`SELECT sram IS NOT NULL AS hasSram FROM "Game" WHERE id = ?`)
    .get(gameId) as { hasSram: number } | undefined;

  return {
    saves: saves.map(s => ({
      name: s.name,
      slotNumber: s.slotNumber,
      createdAt: new Date(s.createdAt).toISOString()
    })),
    hasSram: row?.hasSram === 1
  };
}

/**
 * Applies an already-parsed archive to one account.
 *
 * `archive` must have come through `parseArchive`, which is what makes the
 * blobs below safe to write and what has already dropped any savestate written
 * by a different core build. This function does not re-check that; it is the
 * writer, and the validator is a separate thing on purpose.
 *
 * One transaction for the lot. A half-applied import is the worst outcome
 * available: a player who sees "3 saves imported" and finds one, with no way to
 * tell which two are missing.
 */
export function applyImport(
  db: Database,
  userId: string,
  archive: SaveArchive,
  options: ImportOptions
): ImportReport {
  const ceiling = options.maxGames ?? MAX_GAMES_PER_USER;

  const findByChecksum = db.prepare(`SELECT id FROM "Game" WHERE userId = ? AND crc32 = ?`);
  const countGames = db.prepare(`SELECT COUNT(*) AS n FROM "Game" WHERE userId = ?`);
  const insertGame = db.prepare(`
    INSERT INTO "Game" (id, title, filename, coverUrl, uploadedAt, genre, publisher,
                        developer, releaseDate, players, region, description, crc32,
                        sram, sramUpdatedAt, userId)
    VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)
  `);
  const insertSave = db.prepare(`
    INSERT INTO "Save" (id, name, slotNumber, data, screenshot, createdAt, updatedAt, gameId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const writeSram = db.prepare(`UPDATE "Game" SET sram = ?, sramUpdatedAt = ? WHERE id = ? AND userId = ?`);

  const run = db.transaction((): ImportReport => {
    const report: ImportReport = {
      gamesCreated: 0, gamesMatched: 0, gamesRefused: 0,
      statesImported: 0, duplicates: 0, sramImported: 0, sramKept: 0
    };
    let owned = (countGames.get(userId) as { n: number }).n;

    for (const game of archive.games) {
      /*
       * The match is on the checksum and the account, never on a row id: a
       * `Game` row is per-player (`Game_userId_crc32_key`), so the id in a file
       * from another account names nothing here - and a file that named one
       * would be a file only its author could use.
       */
      const existingRow = findByChecksum.get(userId, game.crc32) as { id: string } | undefined;

      if (!existingRow && owned >= ceiling) {
        // The ceiling the "add a game" route enforces. This is the one endpoint
        // that arrives with two hundred games in a single request, so skipping
        // it here would make the import the way round it.
        report.gamesRefused++;
        continue;
      }

      let gameId: string;
      if (existingRow) {
        gameId = existingRow.id;
        report.gamesMatched++;
      } else {
        gameId = randomUUID();
        insertGame.run(gameId, game.title, game.filename, Date.now(), game.crc32, userId);
        owned++;
        report.gamesCreated++;
      }

      const plan = planGameImport(
        game,
        existingRow ? existingStateOf(db, gameId) : null,
        { replaceSram: options.replaceSram }
      );

      for (const planned of plan.states) {
        /*
         * The original timestamps, not `now`. A hundred hours arriving on a
         * new machine all dated today is a lie about the player's own history,
         * and it is also what makes a second import of the same file
         * recognisable as a duplicate rather than a second copy.
         */
        insertSave.run(
          randomUUID(),
          planned.state.name,
          planned.slotNumber,
          Buffer.from(planned.state.data, 'base64'),
          planned.state.screenshot,
          Date.parse(planned.state.createdAt),
          Date.parse(planned.state.updatedAt),
          gameId
        );
        report.statesImported++;
      }
      report.duplicates += plan.duplicates;

      if (plan.sram === 'write' && game.sram) {
        const at = game.sramUpdatedAt ? Date.parse(game.sramUpdatedAt) : Date.now();
        writeSram.run(Buffer.from(game.sram, 'base64'), at, gameId, userId);
        report.sramImported++;
      } else if (plan.sram === 'kept') {
        report.sramKept++;
      }
    }

    return report;
  });

  return run();
}
