import { Router } from 'express';
import { RedisClientType } from 'redis';
import { User } from '../types/index.js';

export const roomsRouter = Router();

// Middleware to check authentication
const requireAuth = (req: any, res: any, next: any) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
};

roomsRouter.use(requireAuth);

// Get active rooms (from Redis)
roomsRouter.get('/', async (req, res) => {
  // This will be handled by WebSocket layer
  // For now, return empty array
  res.json([]);
});
