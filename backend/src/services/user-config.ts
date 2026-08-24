import { ControlsConfig, KeyConfig } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { updateControlsConfig, findControlsConfig } from '../db/users.js';
import { cache } from '../utils/cache.js';
import { getDefaultControlsConfig, normaliseControlsConfig } from '../utils/key-config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('UserConfig');

function cacheKeyFor(userId: string): string {
  return `keyconfig:${userId}`;
}

/**
 * Player 1's `KeyConfig`, for the room.
 *
 * The room protocol carries only one mapping per member - a remote peer sits
 * on port 2, not a second local player - so it is player 1's table that is
 * wanted here, not the whole config.
 */
export async function getUserKeyConfig(userId: string): Promise<KeyConfig> {
  const cacheKey = cacheKeyFor(userId);
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

/**
 * Persists a user's controls config and invalidates the cache this module
 * hands out through `getUserKeyConfig`.
 *
 * Both live here, in the module that owns the cache, rather than split
 * between a route handler and this file: a write that forgets to invalidate
 * is invisible from the call site that performs it, and only leaves a room
 * player 1's stale bindings for up to five minutes.
 */
export function writeUserControls(userId: string, config: ControlsConfig): void {
  updateControlsConfig(getDb(), userId, JSON.stringify(config));
  cache.delete(cacheKeyFor(userId));
}
