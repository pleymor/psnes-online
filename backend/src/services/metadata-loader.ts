import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { prisma } from '../db/prisma.js';

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
  console.log('🎮 Loading SNES game metadata...');

  try {
    // Read metadata JSON file (from metadata directory, not data which is volume-mounted)
    const metadataPath = path.join(__dirname, '../../metadata/snes-metadata.json');
    const metadataContent = await fs.readFile(metadataPath, 'utf-8');
    const metadata: GameMetadataEntry[] = JSON.parse(metadataContent);

    console.log(`📚 Found ${metadata.length} games in metadata file`);

    // Check if metadata already exists
    const existingCount = await prisma.gameMetadata.count();

    if (existingCount > 0) {
      console.log(`✅ Metadata already loaded (${existingCount} entries), skipping...`);
      return;
    }

    // Insert all metadata entries
    let successCount = 0;
    let errorCount = 0;

    for (const entry of metadata) {
      try {
        await prisma.gameMetadata.create({
          data: {
            title: entry.title,
            altTitle: entry.altTitle,
            genre: entry.genre,
            publisher: entry.publisher,
            developer: entry.developer,
            releaseDate: entry.releaseDate,
            players: entry.players,
            region: entry.region,
            description: entry.description,
            coverUrl: entry.coverUrl,
            crc32: entry.crc32,
            md5: entry.md5
          }
        });
        successCount++;
      } catch (error) {
        console.error(`❌ Failed to load metadata for "${entry.title}":`, error);
        errorCount++;
      }
    }

    console.log(`✅ Metadata loaded successfully: ${successCount} games, ${errorCount} errors`);

    // Load metadata into cache
    metadataCache = await prisma.gameMetadata.findMany();
    console.log(`💾 Cached ${metadataCache.length} metadata entries in memory`);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.log('ℹ️  No metadata file found, continuing without metadata...');
    } else {
      console.error('❌ Failed to load game metadata:', error);
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
    metadataCache = await prisma.gameMetadata.findMany();
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
  const metadata = await prisma.gameMetadata.findFirst({
    where: {
      OR: [
        { crc32: checksum },
        { md5: checksum }
      ]
    }
  });

  return metadata;
}

/**
 * Refreshes/reloads metadata (useful for updates)
 */
export async function refreshGameMetadata(): Promise<void> {
  console.log('🔄 Refreshing game metadata...');

  // Delete all existing metadata
  await prisma.gameMetadata.deleteMany({});
  console.log('🗑️  Cleared existing metadata');

  // Clear cache
  metadataCache = null;

  // Reload from file
  await loadGameMetadata();
}
