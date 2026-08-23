import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { Game, Save, SaveSummary } from './types.js';
import { mergeIdentity, needsIdentification, type IdentityFields } from './game-identity.js';

export interface GameWithSaveSummaries extends Game {
  saves: SaveSummary[];
  /** The catalogue entry this game's dump is linked to, if anyone has said. */
  metadataId: string | null;
  /** Whether to offer the player the chance to say what this game is. */
  needsIdentification: boolean;
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
  // The two joins are what make a contribution retroactive: the identity is
  // resolved on the way out rather than copied into the row at creation, so a
  // link posted today reaches a game added a month ago. A NULL g.crc32 matches
  // nothing, which is the right answer for a row that predates local ROMs.
  const games = db.prepare(`
    SELECT g.*,
           k.metadataId AS linkedMetadataId,
           m.title AS metaTitle, m.genre AS metaGenre, m.publisher AS metaPublisher,
           m.developer AS metaDeveloper, m.releaseDate AS metaReleaseDate,
           m.players AS metaPlayers, m.region AS metaRegion,
           m.description AS metaDescription, m.coverUrl AS metaCoverUrl
    FROM "Game" g
    LEFT JOIN "GameMetadataChecksum" k ON k.crc32 = g.crc32
    LEFT JOIN "GameMetadata" m ON m.id = k.metadataId
    WHERE g.userId = ?
    ORDER BY g.uploadedAt DESC
  `).all(userId) as (GameRow & {
    linkedMetadataId: string | null;
    metaTitle: string | null; metaGenre: string | null; metaPublisher: string | null;
    metaDeveloper: string | null; metaReleaseDate: string | null; metaPlayers: string | null;
    metaRegion: string | null; metaDescription: string | null; metaCoverUrl: string | null;
  })[];
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

  return games.map(row => {
    const identity: IdentityFields | null = row.linkedMetadataId === null ? null : {
      title: row.metaTitle,
      genre: row.metaGenre,
      publisher: row.metaPublisher,
      developer: row.metaDeveloper,
      releaseDate: row.metaReleaseDate,
      players: row.metaPlayers,
      region: row.metaRegion,
      description: row.metaDescription,
      coverUrl: row.metaCoverUrl
    };
    const game = toGame(row);
    return {
      ...mergeIdentity(game, identity),
      saves: byGame.get(row.id) ?? [],
      metadataId: row.linkedMetadataId,
      needsIdentification: needsIdentification(game, identity)
    };
  });
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

/**
 * Ownership check for the save path: returns the id only if the game is theirs.
 *
 * Never pair this with `room.gameId`. A room stores the row of whoever CHOSE
 * the game, and Game.id is per-user, so that pairing silently matches nobody
 * when the other player is the one acting - which is exactly how battery saves
 * were lost under a success acknowledgement. Use `findOwnGameIdForRoom` in
 * `rooms/own-game.ts`, which resolves by the room's checksum instead.
 */
export function findOwnedGameId(db: Database, gameId: string, userId: string): string | null {
  const row = db.prepare(`SELECT id FROM "Game" WHERE id = ? AND userId = ?`)
    .get(gameId, userId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * The two things a room copies from a game, and only if the game is theirs.
 *
 * Neither may come from a client payload: the other player uses `crc32` to
 * find the file on their own disk, and `coverUrl` is broadcast to them and
 * rendered as an image source. `room:choose-game` in particular can be called
 * by the guest, about a room that is not theirs.
 */
export function findOwnedGameForRoom(
  db: Database, gameId: string, userId: string
): { crc32: string | null; coverUrl: string | null } | null {
  const row = db.prepare(`SELECT crc32, coverUrl FROM "Game" WHERE id = ? AND userId = ?`)
    .get(gameId, userId) as { crc32: string | null; coverUrl: string | null } | undefined;
  return row ?? null;
}

/**
 * Écrit la sauvegarde de pile, et dit combien de lignes ont changé.
 *
 * Le compte n'est pas décoratif. Le `AND userId = ?` fait de cette requête une
 * garde autant qu'une écriture : quand la ligne n'est pas celle de l'appelant,
 * elle ne touche rien et ne lève rien. Un appelant qui ignorait le résultat a
 * pu répondre « sauvegardé » pendant une heure de jeu perdue - d'où le retour,
 * que le gestionnaire doit vérifier avant d'accuser réception.
 */
export function saveSram(db: Database, gameId: string, userId: string, sram: Buffer): number {
  const info = db.prepare(`UPDATE "Game" SET sram = ?, sramUpdatedAt = ? WHERE id = ? AND userId = ?`)
    .run(sram, Date.now(), gameId, userId);
  return info.changes;
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
