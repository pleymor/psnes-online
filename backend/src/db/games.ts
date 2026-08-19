import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { Game, Save, SaveSummary } from './types.js';

export interface GameWithSaveSummaries extends Game {
  saves: SaveSummary[];
}

export interface GameWithSaves extends Game {
  saves: Save[];
}

/** The descriptive columns, which a metadata match fills in and a bare add leaves null. */
export interface GameDescriptiveFields {
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  coverUrl: string | null;
}

/** A metadata refresh also rewrites the title, which creation takes separately. */
export interface GameMetadataFields extends GameDescriptiveFields {
  title: string;
}

interface GameRow {
  id: string;
  title: string;
  filename: string;
  coverUrl: string | null;
  uploadedAt: number;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  crc32: string | null;
  sram: Buffer | null;
  sramUpdatedAt: number | null;
  userId: string;
}

function toGame(row: GameRow): Game {
  return {
    id: row.id,
    title: row.title,
    filename: row.filename,
    coverUrl: row.coverUrl,
    uploadedAt: new Date(row.uploadedAt),
    genre: row.genre,
    publisher: row.publisher,
    developer: row.developer,
    releaseDate: row.releaseDate,
    players: row.players,
    region: row.region,
    description: row.description,
    crc32: row.crc32,
    sram: row.sram,
    sramUpdatedAt: row.sramUpdatedAt === null ? null : new Date(row.sramUpdatedAt),
    userId: row.userId
  };
}

export function findGameById(db: Database, id: string): Game | null {
  const row = db.prepare(`SELECT * FROM "Game" WHERE id = ?`).get(id) as GameRow | undefined;
  return row ? toGame(row) : null;
}

export function listGamesFor(db: Database, userId: string): Game[] {
  const rows = db.prepare(`SELECT * FROM "Game" WHERE userId = ?`).all(userId) as GameRow[];
  return rows.map(toGame);
}

/**
 * The library listing. Saves come back as summaries: the blob is up to a
 * megabyte per slot and the listing never used it.
 */
export function listGamesWithSaveSummaries(db: Database, userId: string): GameWithSaveSummaries[] {
  const games = db.prepare(`SELECT * FROM "Game" WHERE userId = ? ORDER BY uploadedAt DESC`)
    .all(userId) as GameRow[];
  if (games.length === 0) return [];

  const summaries = db.prepare(`
    SELECT id, name, slotNumber, screenshot, createdAt, updatedAt, gameId
    FROM "Save" WHERE gameId IN (${games.map(() => '?').join(',')})
  `).all(...games.map(g => g.id)) as (Omit<SaveSummary, 'createdAt' | 'updatedAt'> & {
    createdAt: number; updatedAt: number; gameId: string;
  })[];

  const byGame = new Map<string, SaveSummary[]>();
  for (const s of summaries) {
    const list = byGame.get(s.gameId) ?? [];
    list.push({
      id: s.id,
      name: s.name,
      slotNumber: s.slotNumber,
      screenshot: s.screenshot,
      createdAt: new Date(s.createdAt),
      updatedAt: new Date(s.updatedAt)
    });
    byGame.set(s.gameId, list);
  }

  return games.map(g => ({ ...toGame(g), saves: byGame.get(g.id) ?? [] }));
}

export function findGameWithSaves(db: Database, id: string): GameWithSaves | null {
  const game = findGameById(db, id);
  if (!game) return null;
  const rows = db.prepare(`SELECT * FROM "Save" WHERE gameId = ?`).all(id) as {
    id: string; name: string; slotNumber: number; data: Buffer; screenshot: string | null;
    createdAt: number; updatedAt: number; gameId: string;
  }[];
  return {
    ...game,
    saves: rows.map(r => ({
      id: r.id,
      name: r.name,
      slotNumber: r.slotNumber,
      data: r.data,
      screenshot: r.screenshot,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt),
      gameId: r.gameId
    }))
  };
}

export function findGameByChecksum(db: Database, userId: string, crc32: string): Game | null {
  const row = db.prepare(`SELECT * FROM "Game" WHERE userId = ? AND crc32 = ?`)
    .get(userId, crc32) as GameRow | undefined;
  return row ? toGame(row) : null;
}

export function findOtherGameWithChecksum(
  db: Database, userId: string, crc32: string, excludeGameId: string
): Game | null {
  const row = db.prepare(`SELECT * FROM "Game" WHERE userId = ? AND crc32 = ? AND id != ?`)
    .get(userId, crc32, excludeGameId) as GameRow | undefined;
  return row ? toGame(row) : null;
}

export function countGamesFor(db: Database, userId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "Game" WHERE userId = ?`)
    .get(userId) as { n: number };
  return row.n;
}

export function createGame(
  db: Database,
  input: { title: string; filename: string; crc32: string | null; userId: string } & GameDescriptiveFields
): Game {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO "Game" (id, title, filename, coverUrl, uploadedAt, genre, publisher,
                        developer, releaseDate, players, region, description, crc32,
                        sram, sramUpdatedAt, userId)
    VALUES (@id, @title, @filename, @coverUrl, @uploadedAt, @genre, @publisher,
            @developer, @releaseDate, @players, @region, @description, @crc32,
            NULL, NULL, @userId)
  `).run({
    id,
    title: input.title,
    filename: input.filename,
    coverUrl: input.coverUrl,
    uploadedAt: Date.now(),
    genre: input.genre,
    publisher: input.publisher,
    developer: input.developer,
    releaseDate: input.releaseDate,
    players: input.players,
    region: input.region,
    description: input.description,
    crc32: input.crc32,
    userId: input.userId
  });
  return findGameById(db, id)!;
}

export function updateGameChecksum(db: Database, id: string, crc32: string): Game {
  db.prepare(`UPDATE "Game" SET crc32 = ? WHERE id = ?`).run(crc32, id);
  return findGameById(db, id)!;
}

export function updateGameMetadata(db: Database, id: string, fields: GameMetadataFields): void {
  db.prepare(`
    UPDATE "Game" SET
      title = @title, genre = @genre, publisher = @publisher,
      developer = @developer, releaseDate = @releaseDate, players = @players,
      region = @region, description = @description, coverUrl = @coverUrl
    WHERE id = @id
  `).run({
    id,
    title: fields.title,
    genre: fields.genre,
    publisher: fields.publisher,
    developer: fields.developer,
    releaseDate: fields.releaseDate,
    players: fields.players,
    region: fields.region,
    description: fields.description,
    coverUrl: fields.coverUrl
  });
}

export function deleteGame(db: Database, id: string): void {
  db.prepare(`DELETE FROM "Game" WHERE id = ?`).run(id);
}

/** Ownership check for the save path: returns the id only if the game is theirs. */
export function findOwnedGameId(db: Database, gameId: string, userId: string): string | null {
  const row = db.prepare(`SELECT id FROM "Game" WHERE id = ? AND userId = ?`)
    .get(gameId, userId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function findChecksumOfOwnedGame(db: Database, gameId: string, userId: string): string | null {
  const row = db.prepare(`SELECT crc32 FROM "Game" WHERE id = ? AND userId = ?`)
    .get(gameId, userId) as { crc32: string | null } | undefined;
  return row?.crc32 ?? null;
}

export function saveSram(db: Database, gameId: string, userId: string, sram: Buffer): void {
  db.prepare(`UPDATE "Game" SET sram = ?, sramUpdatedAt = ? WHERE id = ? AND userId = ?`)
    .run(sram, Date.now(), gameId, userId);
}

export function findSram(
  db: Database, gameId: string, userId: string
): { sram: Buffer; sramUpdatedAt: Date | null } | null {
  const row = db.prepare(`SELECT sram, sramUpdatedAt FROM "Game" WHERE id = ? AND userId = ?`)
    .get(gameId, userId) as { sram: Buffer | null; sramUpdatedAt: number | null } | undefined;
  if (!row?.sram) return null;
  return {
    sram: row.sram,
    sramUpdatedAt: row.sramUpdatedAt === null ? null : new Date(row.sramUpdatedAt)
  };
}
