import { KeyConfig } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { findControlsConfig } from '../db/users.js';
import { cache } from '../utils/cache.js';
import { getDefaultControlsConfig, normaliseControlsConfig } from '../utils/key-config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('UserConfig');

/**
 * Player 1's `KeyConfig`, for the room.
 *
 * The room protocol carries only one mapping per member - a remote peer sits
 * on port 2, not a second local player - so it is player 1's table that is
 * wanted here, not the whole config.
 */
export async function getUserKeyConfig(userId: string): Promise<KeyConfig> {
  const cacheKey = `keyconfig:${userId}`;
  const cached = cache.get<KeyConfig>(cacheKey);

  if (cached) {
    return cached;
  }

  let config = getDefaultControlsConfig();

  try {
    const stored = findControlsConfig(getDb(), userId);

    if (stored) {
      config = normaliseControlsConfig(JSON.parse(stored));
    }
  } catch (error) {
    logger.error({ err: error, userId }, 'Error loading user controls config');
  }

  cache.set(cacheKey, config.p1.keys, 300000); // Cache for 5 minutes
  return config.p1.keys;
}
