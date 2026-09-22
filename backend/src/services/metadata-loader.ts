import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/sqlite.js';
import {
  countGameMetadata, insertGameMetadataBatch, listGameMetadata,
  findGameMetadataByChecksum as findMetadataRowByChecksum, syncCatalogue
} from '../db/game-metadata.js';
import { createLogger } from '../utils/logger.js';
import { catalogueIndex } from './catalogue-index.js';
import type { GameMetadata } from '../db/types.js';

/**
 * Réexporté depuis son nouveau module.
 *
 * `catalogue-index.ts` a besoin de cette fonction et ce fichier-ci a besoin de
 * l'index, donc la définition a dû sortir d'ici pour ne pas fermer le cycle.
 * Les appelants - `catalogue-search.ts`, les tests - la trouvent toujours là
 * où ils la cherchaient.
 */
export { normalizeTitle } from './normalise-title.js';
import { normalizeTitle } from './normalise-title.js';

const logger = createLogger('Metadata');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_METADATA_PATH = path.join(__dirname, '../../metadata/snes-metadata.json');

// In-memory cache for game metadata (loaded once at startup)
let metadataCache: GameMetadata[] | null = null;

/**
 * Forgets the cached catalogue, so the next read rebuilds it.
 *
 * The cache feeds both the title matcher and the contribution search. Without
 * this, an entry a player just created would not exist until the container
 * restarted.
 */
export function invalidateMetadataCache(): void {
  metadataCache = null;
}

/** The catalogue as the search and the title matcher see it, loading it on first use. */
export function cachedCatalogue(): GameMetadata[] {
  if (!metadataCache) metadataCache = listGameMetadata(getDb());
  return metadataCache;
}

export interface GameMetadataEntry {
  title: string;
  altTitle?: string;
  genre?: string;
  publisher?: string;
  developer?: string;
  releaseDate?: string;
  players?: string;
  region?: string;
  description?: string;
  coverUrl?: string;
  crc32?: string;
  md5?: string;
}

/** Reads and parses the catalogue file. Throws on a missing or malformed file - callers decide what "before we've touched the database" means. */
async function readMetadataEntries(metadataPath: string): Promise<GameMetadataEntry[]> {
  const metadataContent = await fs.readFile(metadataPath, 'utf-8');
  return JSON.parse(metadataContent);
}

function toMetadataInputs(entries: GameMetadataEntry[]) {
  return entries.map(entry => ({
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
  }));
}

/**
 * Loads SNES game metadata from JSON file and stores it in the database
 * This runs at backend startup to ensure metadata is available
 */
export async function loadGameMetadata(metadataPath: string = DEFAULT_METADATA_PATH): Promise<void> {
  logger.info('Loading SNES game metadata...');

  try {
    // Read metadata JSON file (from metadata directory, not data which is volume-mounted)
    const metadata = await readMetadataEntries(metadataPath);

    logger.info({ count: metadata.length }, 'Found games in metadata file');

    // Check if metadata already exists
    const db = getDb();
    // Counting only the catalogue matters: on a fresh database where reading
    // the JSON failed but a player had contributed an entry, a count of
    // everything would see one row and skip loading the catalogue forever.
    const existingCount = countGameMetadata(db, 'catalogue');

    if (existingCount > 0) {
      logger.info({ count: existingCount }, 'Catalogue already loaded, skipping');
      return;
    }

    // Insert all metadata entries in one transaction. Unlike the old
    // entry-by-entry loop, which caught errors per row and kept going, this
    // fails as a whole on a malformed entry: the catalogue is a JSON file
    // shipped with the image, not user input, so a loud failure here is more
    // honest than an error counter nobody reads. The outer try/catch still
    // lets the app start without metadata.
    const successCount = insertGameMetadataBatch(db, toMetadataInputs(metadata));

    logger.info({ successCount }, 'Metadata loaded successfully');

    // Load metadata into cache
    metadataCache = listGameMetadata(db);
    logger.info({ count: metadataCache.length }, 'Cached metadata entries in memory');
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      logger.warn('No metadata file found, continuing without metadata');
    } else {
      logger.error({ err: error }, 'Failed to load game metadata');
    }
    // Don't throw - allow app to continue without metadata
  }
}

/**
 * Searches for game metadata by title (fuzzy matching)
 * Uses in-memory cache for fast lookups instead of querying database every time
 *
 * La requête est normalisée ici - c'est le titre d'un dump, il n'est dans aucun
 * index - et les fiches le sont une fois pour toutes par `catalogue-index.ts`.
 * Les deux passes sont les mêmes qu'avant, dans le même ordre : l'exacte, qui
 * n'est plus un balayage mais une lecture de carte, puis la partielle, qui
 * balaie encore mais ne renormalise plus rien.
 */
export async function findGameMetadata(title: string): Promise<any | null> {
  const normalizedTitle = normalizeTitle(title);
  const { rows, byTitle } = catalogueIndex(cachedCatalogue());

  const exact = byTitle.get(normalizedTitle);
  if (exact) return exact;

  const partial = rows.find(row =>
    row.title.includes(normalizedTitle) ||
    normalizedTitle.includes(row.title) ||
    (row.altTitle && (
      row.altTitle.includes(normalizedTitle) ||
      normalizedTitle.includes(row.altTitle)
    ))
  );

  return partial?.entry ?? null;
}

/**
 * Searches for game metadata by checksum (CRC32 or MD5)
 */
export async function findGameMetadataByChecksum(checksum: string): Promise<any | null> {
  return findMetadataRowByChecksum(getDb(), checksum);
}

/**
 * Refreshes/reloads metadata (useful for updates).
 *
 * The read and parse happen first, entirely before any write: SQLite
 * transactions here cannot span an `await`, so the file has to be off the disk and
 * in memory before the transaction opens, not merely reordered inside it.
 * Delete and insert then run as one transaction, so a bad JSON file or a
 * malformed entry leaves the previous catalogue exactly as it was, instead of
 * an empty table between a committed delete and an insert that never happens.
 *
 * Run on purpose, never at startup. It used to run at every backend start -
 * every deploy - and the owner's call on 2026-09-10 was to stop that: a
 * catalogue that rewrites itself whenever a container restarts is a catalogue
 * nobody can build on. `db/catalogue-cli.ts` is the way in now.
 *
 * Nothing shipped is deleted and recreated any more: `syncCatalogue` matches
 * the file against the rows by title and updates them in place. Delete and
 * reinsert minted a new id per row on every backend start - every deploy - and
 * `GameMetadataChecksum.metadataId` is `ON DELETE CASCADE`, so every game
 * identified against a shipped entry lost its identification, and every cover
 * a player had uploaded went with the row. That is the whole of "je perds mes
 * jaquettes et descriptions à chaque deploy", reported on 2026-09-10.
 *
 * What a player contributed is still not the file's to reclaim: `syncCatalogue`
 * only ever touches `source = 'catalogue'`.
 */
export async function refreshGameMetadata(metadataPath: string = DEFAULT_METADATA_PATH): Promise<boolean> {
  logger.info('Refreshing game metadata...');

  let entries: GameMetadataEntry[];
  try {
    entries = await readMetadataEntries(metadataPath);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      logger.warn('No metadata file found, keeping existing catalogue');
    } else {
      logger.error({ err: error }, 'Failed to read game metadata file, keeping existing catalogue');
    }
    return false;
  }

  const db = getDb();
  try {
    db.transaction(() => {
      syncCatalogue(db, toMetadataInputs(entries));
    })();
  } catch (error) {
    logger.error({ err: error }, 'Failed to refresh game metadata, keeping existing catalogue');
    return false;
  }

  // Clear and reload the cache only once the new catalogue has actually landed.
  metadataCache = listGameMetadata(db);
  logger.info({ count: metadataCache.length }, 'Refreshed metadata entries in memory');
  return true;
}
