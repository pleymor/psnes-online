import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/sqlite.js';
import {
  countGameMetadata, insertGameMetadataBatch, listGameMetadata,
  findGameMetadataByChecksum as findMetadataRowByChecksum, deleteAllGameMetadata
} from '../db/game-metadata.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Metadata');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory cache for game metadata (loaded once at startup)
let metadataCache: any[] | null = null;

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

/**
 * Loads SNES game metadata from JSON file and stores it in the database
 * This runs at backend startup to ensure metadata is available
 */
export async function loadGameMetadata(): Promise<void> {
  logger.info('Loading SNES game metadata...');

  try {
    // Read metadata JSON file (from metadata directory, not data which is volume-mounted)
    const metadataPath = path.join(__dirname, '../../metadata/snes-metadata.json');
    const metadataContent = await fs.readFile(metadataPath, 'utf-8');
    const metadata: GameMetadataEntry[] = JSON.parse(metadataContent);

    logger.info({ count: metadata.length }, 'Found games in metadata file');

    // Check if metadata already exists
    const db = getDb();
    const existingCount = countGameMetadata(db);

    if (existingCount > 0) {
      logger.info({ count: existingCount }, 'Metadata already loaded, skipping');
      return;
    }

    // Insert all metadata entries in one transaction. Unlike the old
    // entry-by-entry loop, which caught errors per row and kept going, this
    // fails as a whole on a malformed entry: the catalogue is a JSON file
    // shipped with the image, not user input, so a loud failure here is more
    // honest than an error counter nobody reads. The outer try/catch still
    // lets the app start without metadata.
    const successCount = insertGameMetadataBatch(db, metadata.map(entry => ({
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
    })));

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
 * Normalizes a game title for better matching
 * Removes region tags, version numbers, and other common suffixes
 */
function normalizeTitle(title: string): string {
  let normalized = title.toLowerCase().trim();

  // Remove file extensions
  normalized = normalized.replace(/\.(smc|sfc|fig|swc|mgd|zip)$/i, '');

  // Remove common suffixes like "# SNES", "# NES", etc.
  normalized = normalized.replace(/\s*#\s*(snes|nes|n64|sfc|gb|gba|gbc|genesis|sega|md)$/gi, '');

  // Remove region tags including language tags
  normalized = normalized.replace(/\s*\((usa|europe|japan|france|germany|spain|italy|uk|world|ntsc|pal|ntsc-j|eur|jpn|usa, europe|eng|fr|de|es|it|pt|beta|proto|unl)\)/gi, '');

  // Remove version/revision tags
  normalized = normalized.replace(/\s*\((rev\s*\d+|v\d+\.\d+|version\s*\d+)\)/gi, '');

  // Remove bracket numbers [!], [b1], etc.
  normalized = normalized.replace(/\s*\[!?\d*\]/g, '');

  // Remove "The" prefix for better matching
  normalized = normalized.replace(/^the\s+/i, '');

  // Normalize punctuation - replace colons, dashes, apostrophes with spaces
  normalized = normalized.replace(/[:'\-–—]/g, ' ');

  // Remove other punctuation
  normalized = normalized.replace(/[.,!?;()]/g, '');

  // Fix common spelling variations
  normalized = normalized.replace(/butouden/g, 'butoden');
  normalized = normalized.replace(/street fighter ii'/g, 'street fighter ii');

  // Remove extra spaces and trim
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

/**
 * Searches for game metadata by title (fuzzy matching)
 * Uses in-memory cache for fast lookups instead of querying database every time
 */
export async function findGameMetadata(title: string): Promise<any | null> {
  const normalizedTitle = normalizeTitle(title);

  // Load cache if not already loaded
  if (!metadataCache) {
    metadataCache = listGameMetadata(getDb());
  }

  const allMetadata = metadataCache;

  // First try exact match on normalized titles
  let metadata = allMetadata.find(m => {
    const normalizedMetaTitle = normalizeTitle(m.title);
    const normalizedAltTitle = m.altTitle ? normalizeTitle(m.altTitle) : null;

    return normalizedMetaTitle === normalizedTitle ||
           (normalizedAltTitle && normalizedAltTitle === normalizedTitle);
  });

  if (metadata) {
    return metadata;
  }

  // Try partial match (contains, case-insensitive)
  metadata = allMetadata.find(m => {
    const normalizedMetaTitle = normalizeTitle(m.title);
    const normalizedAltTitle = m.altTitle ? normalizeTitle(m.altTitle) : null;

    return normalizedMetaTitle.includes(normalizedTitle) ||
           normalizedTitle.includes(normalizedMetaTitle) ||
           (normalizedAltTitle && (
             normalizedAltTitle.includes(normalizedTitle) ||
             normalizedTitle.includes(normalizedAltTitle)
           ));
  });

  return metadata || null;
}

/**
 * Searches for game metadata by checksum (CRC32 or MD5)
 */
export async function findGameMetadataByChecksum(checksum: string): Promise<any | null> {
  return findMetadataRowByChecksum(getDb(), checksum);
}

/**
 * Refreshes/reloads metadata (useful for updates)
 */
export async function refreshGameMetadata(): Promise<void> {
  logger.info('Refreshing game metadata...');

  // Delete all existing metadata
  deleteAllGameMetadata(getDb());
  logger.info('Cleared existing metadata');

  // Clear cache
  metadataCache = null;

  // Reload from file
  await loadGameMetadata();
}
