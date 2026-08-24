import { Router } from 'express';
import { getDb } from '../db/sqlite.js';
import { findControlsConfig } from '../db/users.js';
import { requireAuth } from '../middleware/auth.js';
import { writeUserControls } from '../services/user-config.js';
import {
  getDefaultControlsConfig,
  isValidControlsConfig,
  normaliseControlsConfig
} from '../utils/key-config.js';
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
      return res.json(getDefaultControlsConfig());
    }

    // Normalised here rather than on the frontend: the database still holds
    // one-player configs, and only one place should know how to read those.
    res.json(normaliseControlsConfig(JSON.parse(stored)));
  } catch (error) {
    logger.error({ err: error }, 'Error fetching controls config');
    res.status(500).json({ error: 'Failed to fetch controls configuration' });
  }
}));

// Update user's controls configuration
userRouter.put('/controls', requireAuth, asyncHandler(async (req, res) => {
  try {
    const userId = (req.user as any).id;

    // Validate the configuration - accepts both the legacy bare KeyConfig
    // and the two-player shape, but never something incomplete.
    if (!isValidControlsConfig(req.body)) {
      return res.status(400).json({ error: 'Invalid controls configuration' });
    }

    const config = normaliseControlsConfig(req.body);
    // Writes and invalidates the room's cached KeyConfig together - see
    // writeUserControls in services/user-config.ts for why that pairing
    // lives there rather than here.
    writeUserControls(userId, config);

    res.json({ message: 'Controls configuration updated successfully', config });
  } catch (error) {
    logger.error({ err: error }, 'Error updating controls config');
    res.status(500).json({ error: 'Failed to update controls configuration' });
  }
}));

// Reset user's controls to default - both players, both tables
userRouter.post('/controls/reset', requireAuth, asyncHandler(async (req, res) => {
  try {
    const userId = (req.user as any).id;
    const defaultConfig = getDefaultControlsConfig();

    writeUserControls(userId, defaultConfig);

    res.json({ message: 'Controls reset to defaults', config: defaultConfig });
  } catch (error) {
    logger.error({ err: error }, 'Error resetting controls config');
    res.status(500).json({ error: 'Failed to reset controls configuration' });
  }
}));
