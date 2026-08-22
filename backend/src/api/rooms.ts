import { Router } from 'express';
import { User } from '../types/index.js';
import { getRooms } from '../websocket/index.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { toPublicRoomFor, visibleRoomsFor } from '../websocket/room-view.js';

export const roomsRouter = Router();

roomsRouter.use(requireAuth);

// Get active rooms visible to the caller: their own, plus their friends'.
// Returning every room let any authenticated user enumerate room ids and then
// act on rooms they have nothing to do with.
roomsRouter.get('/', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const visible = await visibleRoomsFor(user.id, getRooms());
  // Scoped per caller, like `rooms:list`: seeing a friend's room does not
  // extend to seeing whom they have invited into it.
  res.json(visible.map(room => toPublicRoomFor(room, user.id)));
}));
