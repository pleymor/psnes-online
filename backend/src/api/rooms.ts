import { Router } from 'express';
import { RedisClientType } from 'redis';
import { User } from '../types/index.js';
import { getRoom, getRooms } from '../websocket/index.js';

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
roomsRouter.get('/', async (req, res) => {
  const rooms = getRooms();
  const roomsArray = Array.from(rooms.values());
  res.json(roomsArray);
});

// Get a specific room by ID
roomsRouter.get('/:id', async (req, res) => {
  const roomId = req.params.id;
  const room = getRoom(roomId);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  res.json(room);
});
