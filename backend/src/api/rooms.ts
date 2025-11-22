import { Router } from 'express';
import { getRooms } from '../websocket/index.js';

export const roomsRouter = Router();

// Middleware to check authentication
const requireAuth = (req: any, res: any, next: any) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
};

roomsRouter.use(requireAuth);

// Get active rooms
roomsRouter.get('/', async (_req, res) => {
  const rooms = getRooms();
  const roomsArray = Array.from(rooms.values());
  res.json(roomsArray);
});
