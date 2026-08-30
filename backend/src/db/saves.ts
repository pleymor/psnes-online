import { randomUUID } from 'node:crypto';
import { asBuffer, type Database } from './sqlite.js';
import type { Game, Save } from './types.js';

export interface SaveWithGame extends Save {
  game: Game;
}

interface SaveRow {
  id: string;
  name: string;
  slotNumber: number;
  /** As bun:sqlite hands a BLOB back; `asBuffer` turns it into the Buffer callers expect. */
  data: Uint8Array;
  screenshot: string | null;
  createdAt: number;
  updatedAt: number;
  gameId: string;
}

function toSave(row: SaveRow): Save {
  return {
    id: row.id,
    name: row.name,
    slotNumber: row.slotNumber,
    data: asBuffer(row.data),
    screenshot: row.screenshot,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    gameId: row.gameId
  };
}

export function findSaveWithGame(db: Database, id: string): SaveWithGame | null {
  const row = db.prepare(`
    SELECT s.*,
      g.id AS g_id, g.title AS g_title, g.filename AS g_filename, g.coverUrl AS g_coverUrl,
      g.uploadedAt AS g_uploadedAt, g.genre AS g_genre, g.publisher AS g_publisher,
      g.developer AS g_developer, g.releaseDate AS g_releaseDate, g.players AS g_players,
      g.region AS g_region, g.description AS g_description, g.crc32 AS g_crc32,
      g.sram AS g_sram, g.sramUpdatedAt AS g_sramUpdatedAt, g.userId AS g_userId
    FROM "Save" s
    JOIN "Game" g ON g.id = s.gameId
    WHERE s.id = ?
  `).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const game: Game = {
    id: row.g_id as string,
    title: row.g_title as string,
    filename: row.g_filename as string,
    coverUrl: (row.g_coverUrl as string | null) ?? null,
    uploadedAt: new Date(row.g_uploadedAt as number),
    genre: (row.g_genre as string | null) ?? null,
    publisher: (row.g_publisher as string | null) ?? null,
    developer: (row.g_developer as string | null) ?? null,
    releaseDate: (row.g_releaseDate as string | null) ?? null,
    players: (row.g_players as string | null) ?? null,
    region: (row.g_region as string | null) ?? null,
    description: (row.g_description as string | null) ?? null,
    crc32: (row.g_crc32 as string | null) ?? null,
    sram: asBuffer(row.g_sram as Uint8Array | null),
    sramUpdatedAt: row.g_sramUpdatedAt === null ? null : new Date(row.g_sramUpdatedAt as number),
    userId: row.g_userId as string
  };

  return {
    ...toSave({
      id: row.id as string,
      name: row.name as string,
      slotNumber: row.slotNumber as number,
      data: asBuffer(row.data as Uint8Array),
      screenshot: (row.screenshot as string | null) ?? null,
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
      gameId: row.gameId as string
    }),
    game
  };
}

export function createSave(
  db: Database,
  input: { gameId: string; slotNumber: number; name: string; data: Buffer; screenshot: string | null }
): Save {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO "Save" (id, name, slotNumber, data, screenshot, createdAt, updatedAt, gameId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.name, input.slotNumber, input.data, input.screenshot, now, now, input.gameId);

  const row = db.prepare(`SELECT * FROM "Save" WHERE id = ?`).get(id) as SaveRow;
  return toSave(row);
}

/**
 * Overwrites a save in place.
 *
 * The thumbnail goes with the state it depicts, including when there is none:
 * passing null clears it rather than leaving a picture of a moment that has
 * been written over.
 */
export function updateSaveData(
  db: Database,
  id: string,
  name: string,
  data: Buffer,
  screenshot: string | null
): void {
  db.prepare(`UPDATE "Save" SET name = ?, data = ?, screenshot = ?, updatedAt = ? WHERE id = ?`)
    .run(name, data, screenshot, Date.now(), id);
}

/**
 * The slot number a new save should take.
 *
 * Slot numbers are no longer chosen by the player - the picker is gone - so
 * they are identity rather than seating. This never reuses a gap left by a
 * deleted save: two different savestates sharing a slot number would make any
 * old log line ambiguous about which one it meant.
 *
 * There is deliberately no ceiling. The old ten-slot limit lived in the UI,
 * not the schema, and the only constraint here is uniqueness per game.
 */
export function nextFreeSlot(db: Database, gameId: string): number {
  const row = db.prepare(`SELECT MAX(slotNumber) AS highest FROM "Save" WHERE gameId = ?`)
    .get(gameId) as { highest: number | null };
  return (row.highest ?? 0) + 1;
}

/** The two identities a save has, neither of which is its contents. */
export interface SaveOwnership {
  ownerId: string;
  gameId: string;
}

/**
 * Who owns a save and which game it belongs to.
 *
 * Both, because the delete route needs both: owning the game named in the URL
 * says nothing about the save named in it. The overwrite path only needs the
 * owner and gets it through `findSaveOwnerId` below.
 *
 * Called on every attempt, so it reads two columns and joins - it must not pull
 * the savestate along, which is over 800KB.
 */
export function findSaveOwnership(db: Database, saveId: string): SaveOwnership | null {
  const row = db.prepare(`
    SELECT g.userId AS ownerId, s.gameId AS gameId
    FROM "Save" s
    JOIN "Game" g ON g.id = s.gameId
    WHERE s.id = ?
  `).get(saveId) as SaveOwnership | undefined;
  return row ?? null;
}

/** Who owns a save, by way of the game it belongs to. */
export function findSaveOwnerId(db: Database, saveId: string): string | null {
  return findSaveOwnership(db, saveId)?.ownerId ?? null;
}

/**
 * Removes a save. Returns whether there was one to remove.
 *
 * The boolean is not decoration. The route has already established the save
 * exists and is the caller's, but two clicks or two tabs can slip a second
 * delete in between; without this, the loser of that race is told its deletion
 * did something it did not.
 */
export function deleteSave(db: Database, id: string): boolean {
  return db.prepare(`DELETE FROM "Save" WHERE id = ?`).run(id).changes > 0;
}
