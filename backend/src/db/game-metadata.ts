import { randomUUID } from 'node:crypto';
import { asBuffer, type Database } from './sqlite.js';
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

/**
 * Explicit nulls, not absent keys: the JSON catalogue is full of holes, and a
 * bound parameter has to have a value. better-sqlite3 threw on `undefined`;
 * bun:sqlite in strict mode throws on a *missing* key and silently writes NULL
 * for a present-but-undefined one - so normalising here is what keeps the
 * difference between "absent" and "null" from depending on the driver.
 */
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

/**
 * Brings the shipped catalogue in line with the file, without destroying it.
 *
 * This used to be a DELETE of every `source = 'catalogue'` row followed by an
 * INSERT of the file, and `insertGameMetadataBatch` mints a fresh
 * `randomUUID()` per row - so every shipped entry changed identity at every
 * backend start, which is every deploy. `GameMetadataChecksum.metadataId` is
 * `ON DELETE CASCADE`, and a player's uploaded cover lives in the row itself,
 * so both went with it. Production on 2026-09-10 had 65 games in libraries,
 * 1475 catalogue rows and **2 surviving links** - the only two pointing at
 * community entries. Reported as "je perds mes jaquettes et descriptions à
 * chaque deploy", and that is exactly what it was.
 *
 * The title is the key. The file carries no id, no crc32 and no md5 - only
 * titles, and all 1475 of them are distinct - so it is the only stable handle
 * there is. A title the file renames therefore still reads as one entry
 * leaving and another arriving, and the link on the old one is lost; that is
 * a real limit, and the remedy is an id in the file, not a cleverer match.
 *
 * A cover a player uploaded is never overwritten. The file carries its own
 * `coverUrl`, and reapplying it would erase the one image here that cannot be
 * regenerated from anything.
 */
export function syncCatalogue(db: Database, entries: GameMetadataInput[]): void {
  const existing = db.prepare(`
    SELECT id, title, cover IS NOT NULL AS hasCover FROM "GameMetadata" WHERE source = 'catalogue'
  `).all() as { id: string; title: string; hasCover: number }[];
  const byTitle = new Map(existing.map(row => [row.title, row]));

  const update = db.prepare(`
    UPDATE "GameMetadata"
       SET altTitle = @altTitle, genre = @genre, publisher = @publisher,
           developer = @developer, releaseDate = @releaseDate, players = @players,
           region = @region, description = @description, crc32 = @crc32, md5 = @md5,
           updatedAt = @now
     WHERE id = @id
  `);
  // Two statements rather than one with a CASE: the cover columns are the
  // whole difference, and a row the player has illustrated must not have its
  // `coverUrl` rewritten to the file's.
  const updateWithCover = db.prepare(`
    UPDATE "GameMetadata"
       SET altTitle = @altTitle, genre = @genre, publisher = @publisher,
           developer = @developer, releaseDate = @releaseDate, players = @players,
           region = @region, description = @description, crc32 = @crc32, md5 = @md5,
           coverUrl = @coverUrl, updatedAt = @now
     WHERE id = @id
  `);
  const insert = db.prepare(INSERT);
  const remove = db.prepare(`DELETE FROM "GameMetadata" WHERE id = ?`);

  const now = Date.now();
  const seen = new Set<string>();

  for (const entry of entries) {
    const row = normalise(entry);
    seen.add(row.title);
    const found = byTitle.get(row.title);

    if (!found) {
      insert.run({ id: randomUUID(), now, ...row });
    } else if (found.hasCover) {
      const { coverUrl, ...rest } = row;
      update.run({ ...rest, id: found.id, now });
    } else {
      updateWithCover.run({ ...row, id: found.id, now });
    }
  }

  // Only the titles the file has actually dropped. Their links go with them,
  // which is right: the entry they named no longer exists.
  for (const row of existing) {
    if (!seen.has(row.title)) remove.run(row.id);
  }
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
 * What a player may fill in.
 *
 * Every field is optional except the title, and even that falls back upstream
 * to the game's current name -- so "all optional" holds without leaving a row
 * with a NULL title, which the column forbids. Nulls rather than optional keys
 * because a bound parameter has to have a value: bun:sqlite (strict mode)
 * throws `Missing parameter` for a key that is not there at all.
 */
export interface CommunityEntryInput {
  title: string;
  altTitle: string | null;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
}

export function findGameMetadataById(db: Database, id: string): GameMetadata | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM "GameMetadata" WHERE id = ?`)
    .get(id) as MetadataRow | undefined;
  return row ? toMetadata(row) : null;
}

/**
 * Records an entry a player wrote.
 *
 * `source` is 'community', which is what keeps the JSON refresh from deleting
 * it, and `contributedBy` is what makes a wrong entry traceable later -- the
 * two halves of "immediate, attributed, reversible".
 */
export function insertCommunityMetadata(
  db: Database,
  entry: CommunityEntryInput,
  contributedBy: string
): GameMetadata {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO "GameMetadata" (id, title, altTitle, genre, publisher, developer,
                                releaseDate, players, region, description, coverUrl,
                                crc32, md5, source, contributedBy, createdAt, updatedAt)
    VALUES (@id, @title, @altTitle, @genre, @publisher, @developer,
            @releaseDate, @players, @region, @description, NULL,
            NULL, NULL, 'community', @contributedBy, @now, @now)
  `).run({ id, contributedBy, now, ...entry });
  return findGameMetadataById(db, id)!;
}

/**
 * Rewrites an entry a player wrote.
 *
 * Every descriptive column is replaced, not merged: the form sends all of them
 * every time, so a box left empty means "this was wrong" rather than "leave it
 * alone". A merge would make a wrong value impossible to remove.
 *
 * `source = 'community'` in the WHERE is the whole of the authorisation this
 * layer performs, and it is not about who may edit - `ownsDumpLinkedTo` answers
 * that upstream. It is about what an edit would be worth: `syncCatalogue`
 * overwrites every shipped row from the file, so an edit to one survives only
 * until the next catalogue sync. Returning null says so now instead of losing
 * the work silently later - and the UI answers it by writing a community copy
 * and pointing the dump at that instead.
 *
 * The cover is untouched: it has its own write in `setCover`, and it is the one
 * field the form does not carry.
 */
export function updateCommunityMetadata(
  db: Database,
  id: string,
  entry: CommunityEntryInput
): GameMetadata | null {
  const changed = db.prepare(`
    UPDATE "GameMetadata"
       SET title = @title, altTitle = @altTitle, genre = @genre,
           publisher = @publisher, developer = @developer,
           releaseDate = @releaseDate, players = @players, region = @region,
           description = @description, updatedAt = @now
     WHERE id = @id AND source = 'community'
  `).run({ id, now: Date.now(), ...entry });

  // bun:sqlite reports the rows the statement touched; zero means the id was
  // unknown or the row is a shipped one, and both answer "no".
  return changed.changes === 0 ? null : findGameMetadataById(db, id);
}

/**
 * Stores a cover and returns the URL that serves it.
 *
 * The URL carries the write's timestamp. Without it the response could not be
 * cached for long -- replacing a cover would leave every client that had
 * already fetched the old one showing it until the cache expired.
 */
export function setCover(db: Database, metadataId: string, bytes: Buffer, mime: string): string {
  const now = Date.now();
  const coverUrl = `/api/covers/${metadataId}?v=${now}`;
  db.prepare(`UPDATE "GameMetadata" SET cover = ?, coverMime = ?, coverUrl = ?, updatedAt = ? WHERE id = ?`)
    .run(bytes, mime, coverUrl, now, metadataId);
  return coverUrl;
}

/** The only path the cover bytes take out of the database. */
export function findCover(db: Database, metadataId: string): { bytes: Buffer; mime: string } | null {
  const row = db.prepare(`SELECT cover, coverMime FROM "GameMetadata" WHERE id = ?`)
    .get(metadataId) as { cover: Uint8Array | null; coverMime: string | null } | undefined;
  if (!row || !row.cover || !row.coverMime) return null;
  return { bytes: asBuffer(row.cover), mime: row.coverMime };
}
