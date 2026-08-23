import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { GameMetadata, MetadataSource } from './types.js';

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

/**
 * Every column except `cover`.
 *
 * `SELECT *` would pull the cover bytes into every read, and this module's
 * `listGameMetadata` is what fills the in-memory catalogue cache -- so a star
 * there means holding every cover in memory and re-reading them all on each
 * invalidation. The bytes leave only through `findCover`.
 */
const COLUMNS = `
  id, title, altTitle, genre, publisher, developer, releaseDate, players,
  region, description, coverUrl, crc32, md5, source, contributedBy,
  coverMime, createdAt, updatedAt
`;

interface MetadataRow extends Omit<GameMetadata, 'createdAt' | 'updatedAt' | 'hasCover'> {
  createdAt: number;
  updatedAt: number;
  coverMime: string | null;
}

function toMetadata(row: MetadataRow): GameMetadata {
  return {
    id: row.id,
    title: row.title,
    altTitle: row.altTitle,
    genre: row.genre,
    publisher: row.publisher,
    developer: row.developer,
    releaseDate: row.releaseDate,
    players: row.players,
    region: row.region,
    description: row.description,
    coverUrl: row.coverUrl,
    crc32: row.crc32,
    md5: row.md5,
    source: row.source,
    contributedBy: row.contributedBy,
    hasCover: row.coverMime !== null,
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

export function countGameMetadata(db: Database, source?: MetadataSource): number {
  const row = source
    ? db.prepare(`SELECT COUNT(*) AS n FROM "GameMetadata" WHERE source = ?`).get(source)
    : db.prepare(`SELECT COUNT(*) AS n FROM "GameMetadata"`).get();
  return (row as { n: number }).n;
}

/**
 * Loads the whole catalogue in one transaction.
 *
 * The old loader inserted the catalogue's 94 rows (33 KB of JSON) one
 * statement at a time, each its own implicit transaction. One transaction
 * turns that from 94 fsyncs into one.
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
  const rows = db.prepare(`SELECT ${COLUMNS} FROM "GameMetadata"`).all() as MetadataRow[];
  return rows.map(toMetadata);
}

export function findGameMetadataByChecksum(db: Database, checksum: string): GameMetadata | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM "GameMetadata" WHERE crc32 = ? OR md5 = ?`)
    .get(checksum, checksum) as MetadataRow | undefined;
  return row ? toMetadata(row) : null;
}

/**
 * Drops the rows the JSON file owns, and only those.
 *
 * The refresh path deletes the catalogue and reinserts it from the file. Before
 * the source column existed this was an unqualified DELETE, so anything a
 * player had contributed vanished on the next refresh.
 */
export function deleteCatalogueMetadata(db: Database): void {
  db.prepare(`DELETE FROM "GameMetadata" WHERE source = 'catalogue'`).run();
}
