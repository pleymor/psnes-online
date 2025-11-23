import { Router } from 'express';
import type { KeyConfig } from '../types';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { getDefaultKeyConfig, isValidKeyConfig } from '../utils/key-config.js';

export const userRouter = Router();

// Get user's controls configuration
userRouter.get('/controls', requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any).id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { controlsConfig: true }
    });

    if (!user || !user.controlsConfig) {
      // Return default configuration if none saved
      return res.json(getDefaultKeyConfig());
    }

    const config = JSON.parse(user.controlsConfig);
    res.json(config);
  } catch (error) {
    console.error('Error fetching controls config:', error);
    res.status(500).json({ error: 'Failed to fetch controls configuration' });
  }
});

// Update user's controls configuration
userRouter.put('/controls', requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any).id;
    const config: KeyConfig = req.body;

    // Validate the configuration
    if (!isValidKeyConfig(config)) {
      return res.status(400).json({ error: 'Invalid controls configuration' });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { controlsConfig: JSON.stringify(config) }
    });

    res.json({ message: 'Controls configuration updated successfully', config });
  } catch (error) {
    console.error('Error updating controls config:', error);
    res.status(500).json({ error: 'Failed to update controls configuration' });
  }
});

// Reset user's controls to default
userRouter.post('/controls/reset', requireAuth, async (req, res) => {
  try {
    const userId = (req.user as any).id;
    const defaultConfig = getDefaultKeyConfig();

    await prisma.user.update({
      where: { id: userId },
      data: { controlsConfig: JSON.stringify(defaultConfig) }
    });

    res.json({ message: 'Controls reset to defaults', config: defaultConfig });
  } catch (error) {
    console.error('Error resetting controls config:', error);
    res.status(500).json({ error: 'Failed to reset controls configuration' });
  }
});

