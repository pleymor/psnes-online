import { createClient, type RedisClientType } from 'redis';
import { logger } from '../utils/logger.js';

/**
 * The one Redis connection, mirroring db/prisma.ts.
 *
 * Sessions and the room snapshot both need it, and the snapshot lives under
 * websocket/ which index.ts already imports - so keeping the client in
 * index.ts would mean an import cycle.
 *
 * The client is built inside connectRedis() rather than at module scope
 * because index.ts calls dotenv.config() *after* its imports run: reading
 * REDIS_HOST at import time would quietly fall back to localhost in
 * development, where the host comes from .env.
 */
let client: RedisClientType | null = null;

export async function connectRedis(): Promise<RedisClientType> {
  if (client) return client;

  const fresh: RedisClientType = createClient({
    socket: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379')
    }
  });

  fresh.on('error', err => logger.error({ err }, 'Redis error'));
  await fresh.connect();
  client = fresh;
  return client;
}

export function getRedis(): RedisClientType {
  if (!client) throw new Error('connectRedis() has not completed yet');
  return client;
}
