import { KeyConfig } from '../types/index.js';
import { prisma } from '../db/prisma.js';
import { cache } from '../utils/cache.js';
import { getDefaultKeyConfig } from '../utils/key-config.js';

export async function getUserKeyConfig(userId: string): Promise<KeyConfig> {
  const cacheKey = `keyconfig:${userId}`;
  let config = cache.get<KeyConfig>(cacheKey);

  if (config) {
    return config;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { controlsConfig: true }
    });

    if (user?.controlsConfig) {
      const parsedConfig = JSON.parse(user.controlsConfig);
      cache.set(cacheKey, parsedConfig, 300000); // Cache for 5 minutes
      return parsedConfig;
    }
  } catch (error) {
    console.error('Error loading user controls config:', error);
  }

  const defaultConfig = getDefaultKeyConfig();
  cache.set(cacheKey, defaultConfig, 300000);
  return defaultConfig;
}
