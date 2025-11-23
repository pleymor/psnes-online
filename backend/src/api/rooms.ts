import { Router } from 'express';
import { getRooms } from '../websocket/index.js';
import { requireAuth } from '../middleware/auth.js';

export const roomsRouter = Router();

roomsRouter.use(requireAuth);

// Get active rooms
roomsRouter.get('/', async (_req, res) => {
  const rooms = getRooms();
  const roomsArray = Array.from(rooms.values());
  res.json(roomsArray);
});
