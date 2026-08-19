import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { GameMetadata } from './types.js';

export interface GameMetadataInput {
  title: string;
  altTitle: string | null;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  coverUrl: string | null;
  crc32: string | null;
  md5: string | null;
}

interface MetadataRow extends Omit<GameMetadata, 'createdAt' | 'updatedAt'> {
  createdAt: number;
  updatedAt: number;
}

function toMetadata(row: MetadataRow): GameMetadata {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}

const INSERT = `
  INSERT INTO "GameMetadata" (id, title, altTitle, genre, publisher, developer,
                              releaseDate, players, region, description, coverUrl,
                              crc32, md5, createdAt, updatedAt)
  VALUES (@id, @title, @altTitle, @genre, @publisher, @developer,
          @releaseDate, @players, @region, @description, @coverUrl,
          @crc32, @md5, @now, @now)
`;

/** `undefined` binds as an error in better-sqlite3; the JSON catalogue is full of holes. */
function normalise(entry: GameMetadataInput): GameMetadataInput {
  return {
    title: entry.title,
    altTitle: entry.altTitle ?? null,
    genre: entry.genre ?? null,
    publisher: entry.publisher ?? null,
    developer: entry.developer ?? null,
    releaseDate: entry.releaseDate ?? null,
    players: entry.players ?? null,
    region: entry.region ?? null,
    description: entry.description ?? null,
    coverUrl: entry.coverUrl ?? null,
    crc32: entry.crc32 ?? null,
    md5: entry.md5 ?? null
  };
}

export function countGameMetadata(db: Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "GameMetadata"`).get() as { n: number };
  return row.n;
}

/**
 * Loads the whole catalogue in one transaction.
 *
 * The old loader inserted several thousand rows one statement at a time, each
 * its own implicit transaction. One transaction turns that from thousands of
 * fsyncs into one.
 */
export function insertGameMetadataBatch(db: Database, entries: GameMetadataInput[]): number {
  const statement = db.prepare(INSERT);
  const now = Date.now();
  const run = db.transaction((rows: GameMetadataInput[]) => {
    for (const entry of rows) {
      statement.run({ id: randomUUID(), now, ...normalise(entry) });
    }
    return rows.length;
  });
  return run(entries);
}

export function listGameMetadata(db: Database): GameMetadata[] {
  const rows = db.prepare(`SELECT * FROM "GameMetadata"`).all() as MetadataRow[];
  return rows.map(toMetadata);
}

export function findGameMetadataByChecksum(db: Database, checksum: string): GameMetadata | null {
  const row = db.prepare(`SELECT * FROM "GameMetadata" WHERE crc32 = ? OR md5 = ?`)
    .get(checksum, checksum) as MetadataRow | undefined;
  return row ? toMetadata(row) : null;
}

export function deleteAllGameMetadata(db: Database): void {
  db.prepare(`DELETE FROM "GameMetadata"`).run();
}
