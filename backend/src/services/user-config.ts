import { KeyConfig } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { findControlsConfig } from '../db/users.js';
import { cache } from '../utils/cache.js';
import { getDefaultKeyConfig } from '../utils/key-config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('UserConfig');

export async function getUserKeyConfig(userId: string): Promise<KeyConfig> {
  const cacheKey = `keyconfig:${userId}`;
  let config = cache.get<KeyConfig>(cacheKey);

  if (config) {
    return config;
  }

  try {
    const stored = findControlsConfig(getDb(), userId);

    if (stored) {
      const parsedConfig = JSON.parse(stored);
      cache.set(cacheKey, parsedConfig, 300000); // Cache for 5 minutes
      return parsedConfig;
    }
  } catch (error) {
    logger.error({ err: error, userId }, 'Error loading user controls config');
  }

  const defaultConfig = getDefaultKeyConfig();
  cache.set(cacheKey, defaultConfig, 300000);
  return defaultConfig;
}
