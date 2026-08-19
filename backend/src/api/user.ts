import { Router } from 'express';
import type { KeyConfig } from '../types';
import { getDb } from '../db/sqlite.js';
import { findControlsConfig, updateControlsConfig } from '../db/users.js';
import { requireAuth } from '../middleware/auth.js';
import { getDefaultKeyConfig, isValidKeyConfig } from '../utils/key-config.js';
import { createLogger } from '../utils/logger.js';
import { asyncHandler } from '../middleware/async-handler.js';

const logger = createLogger('User');

export const userRouter = Router();

// Get user's controls configuration
userRouter.get('/controls', requireAuth, asyncHandler(async (req, res) => {
  try {
    const userId = (req.user as any).id;
    const stored = findControlsConfig(getDb(), userId);

    if (!stored) {
      // Return default configuration if none saved
      return res.json(getDefaultKeyConfig());
    }

    const config = JSON.parse(stored);
    res.json(config);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching controls config');
    res.status(500).json({ error: 'Failed to fetch controls configuration' });
  }
}));

// Update user's controls configuration
userRouter.put('/controls', requireAuth, asyncHandler(async (req, res) => {
  try {
    const userId = (req.user as any).id;
    const config: KeyConfig = req.body;

    // Validate the configuration
    if (!isValidKeyConfig(config)) {
      return res.status(400).json({ error: 'Invalid controls configuration' });
    }

    updateControlsConfig(getDb(), userId, JSON.stringify(config));

    res.json({ message: 'Controls configuration updated successfully', config });
  } catch (error) {
    logger.error({ err: error }, 'Error updating controls config');
    res.status(500).json({ error: 'Failed to update controls configuration' });
  }
}));

// Reset user's controls to default
userRouter.post('/controls/reset', requireAuth, asyncHandler(async (req, res) => {
  try {
    const userId = (req.user as any).id;
    const defaultConfig = getDefaultKeyConfig();

    updateControlsConfig(getDb(), userId, JSON.stringify(defaultConfig));

    res.json({ message: 'Controls reset to defaults', config: defaultConfig });
  } catch (error) {
    logger.error({ err: error }, 'Error resetting controls config');
    res.status(500).json({ error: 'Failed to reset controls configuration' });
  }
}));

