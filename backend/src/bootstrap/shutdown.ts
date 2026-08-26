import { Server } from 'http';
import type { RedisClientType } from 'redis';

import { Room } from '../types/index.js';
import { flushRooms } from '../websocket/room-snapshot.js';
import { logger } from '../utils/logger.js';

/**
 * A deployment is a graceful shutdown: Docker sends SIGTERM and waits ten
 * seconds. Flushing here is what makes the room snapshot exact for the case
 * that motivated it - the periodic write only covers a hard crash.
 */
export function installShutdownHandlers(opts: {
  httpServer: Server;
  redisClient: RedisClientType;
  rooms: Map<string, Room>;
}): void {
  const { httpServer, redisClient, rooms } = opts;
  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down; saving rooms');

    try {
      await flushRooms(rooms);
    } catch (err) {
      logger.error({ err }, 'Could not save rooms on the way out');
    }

    httpServer.close();
    try {
      await redisClient.quit();
    } catch {
      // Already gone; nothing to salvage and nothing to report.
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
