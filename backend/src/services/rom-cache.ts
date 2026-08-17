import { promises as fs } from 'fs';
import path from 'path';
import { Game } from '@prisma/client';
import { readRom } from './rom-source.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RomCache');
const CACHE_DIR = process.env.ROM_CACHE_DIR || './rom-cache';
const CACHE_TTL = 1000 * 60 * 60 * 2; // 2 hours

interface CacheEntry {
  roomId: string;
  filePath: string;
  createdAt: Date;
  hostUserId: string;
}

const activeCaches = new Map<string, CacheEntry>();

export async function cacheRomForRoom(
  roomId: string,
  hostUserId: string,
  game: Game
): Promise<string> {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  const filePath = path.join(CACHE_DIR, `${roomId}.rom`);

  logger.info({ roomId, gameId: game.id }, 'Caching ROM for room');
  const romBuffer = await readRom(game, hostUserId);

  await fs.writeFile(filePath, romBuffer);

  activeCaches.set(roomId, {
    roomId,
    filePath,
    createdAt: new Date(),
    hostUserId
  });

  logger.info({ roomId, size: romBuffer.length }, 'ROM cached for room');
  return filePath;
}

export async function getCachedRom(roomId: string): Promise<string | null> {
  const entry = activeCaches.get(roomId);
  if (!entry) return null;

  try {
    await fs.access(entry.filePath);

    // Treat an archive in the cache as a miss so it is fetched again.
    //
    // The cache lives in a volume that outlives a deploy, and entries written
    // before archives were expanded on read are still zips. The lockstep core
    // does not reject one: it runs at full speed and renders black, so a stale
    // entry would look like a netcode bug for as long as the room existed.
    const head = Buffer.alloc(4);
    const handle = await fs.open(entry.filePath, 'r');
    try {
      await handle.read(head, 0, 4, 0);
    } finally {
      await handle.close();
    }
    if (head.readUInt32LE(0) === 0x04034b50) {
      logger.warn({ roomId }, 'Cached ROM is still an archive, re-caching');
      activeCaches.delete(roomId);
      return null;
    }

    return entry.filePath;
  } catch {
    activeCaches.delete(roomId);
    return null;
  }
}

export async function cleanupRoomCache(roomId: string): Promise<void> {
  const entry = activeCaches.get(roomId);
  if (!entry) return;

  try {
    await fs.unlink(entry.filePath);
    logger.info({ roomId }, 'ROM cache cleaned up');
  } catch (error) {
    logger.error({ err: error, roomId }, 'Failed to cleanup ROM cache');
  }

  activeCaches.delete(roomId);
}

// Periodic cleanup of stale caches
setInterval(async () => {
  const now = Date.now();
  for (const [roomId, entry] of activeCaches) {
    if (now - entry.createdAt.getTime() > CACHE_TTL) {
      logger.info({ roomId }, 'Cleaning up stale ROM cache');
      await cleanupRoomCache(roomId);
    }
  }
}, 1000 * 60 * 15); // Run every 15 minutes
