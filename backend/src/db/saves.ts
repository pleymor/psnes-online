import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { Game, Save } from './types.js';

export interface SaveWithGame extends Save {
  game: Game;
}

interface SaveRow {
  id: string;
  name: string;
  slotNumber: number;
  data: Buffer;
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
    data: row.data,
    screenshot: row.screenshot,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    gameId: row.gameId
  };
}

/**
 * Finds a slot, but only inside a game the caller owns.
 *
 * The ownership test is part of the query rather than a check afterwards: a
 * guest sitting in someone else room must never reach the host slots, and a
 * filter that lives in the SQL cannot be forgotten by a caller.
 */
export function findSaveInSlot(
  db: Database, gameId: string, slotNumber: number, ownerId: string
): Save | null {
  const row = db.prepare(`
    SELECT s.* FROM "Save" s
    JOIN "Game" g ON g.id = s.gameId
    WHERE s.gameId = ? AND s.slotNumber = ? AND g.userId = ?
  `).get(gameId, slotNumber, ownerId) as SaveRow | undefined;
  return row ? toSave(row) : null;
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
    sram: (row.g_sram as Buffer | null) ?? null,
    sramUpdatedAt: row.g_sramUpdatedAt === null ? null : new Date(row.g_sramUpdatedAt as number),
    userId: row.g_userId as string
  };

  return {
    ...toSave({
      id: row.id as string,
      name: row.name as string,
      slotNumber: row.slotNumber as number,
      data: row.data as Buffer,
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

export function updateSaveData(db: Database, id: string, name: string, data: Buffer): void {
  db.prepare(`UPDATE "Save" SET name = ?, data = ?, updatedAt = ? WHERE id = ?`)
    .run(name, data, Date.now(), id);
}
