import { Router } from 'express';
import { Room, User } from '../types/index.js';
import { getRooms } from '../websocket/index.js';
import { requireAuth } from '../middleware/auth.js';
import { getFriendships } from '../services/friends.js';

export const roomsRouter = Router();

roomsRouter.use(requireAuth);

/**
 * Strips fields the client has no use for. `keyConfig` in particular is a
 * per-player setting that never needs to leave the room it belongs to.
 */
function toPublicRoom(room: Room) {
  return {
    id: room.id,
    gameId: room.gameId,
    gameTitle: room.gameTitle,
    gameCoverUrl: room.gameCoverUrl,
    hostId: room.hostId,
    createdBy: room.createdBy,
    status: room.status,
    emulationMode: room.emulationMode,
    createdAt: room.createdAt,
    players: room.players.map(p => ({
      userId: p.userId,
      displayName: p.displayName,
      avatar: p.avatar,
      port: p.port,
      isReady: p.isReady
    }))
  };
}

// Get active rooms visible to the caller: their own, plus their friends'.
// Returning every room let any authenticated user enumerate room ids and then
// act on rooms they have nothing to do with.
roomsRouter.get('/', async (req, res) => {
  const user = req.user as User;

  const friendships = await getFriendships(user.id);
  const visibleUserIds = new Set<string>([user.id]);
  for (const friendship of friendships) {
    visibleUserIds.add(
      friendship.initiatorId === user.id ? friendship.receiverId : friendship.initiatorId
    );
  }

  const visibleRooms = Array.from(getRooms().values()).filter(room =>
    room.players.some(p => p.userId === user.id) ||
    visibleUserIds.has(room.createdBy) ||
    visibleUserIds.has(room.hostId)
  );

  res.json(visibleRooms.map(toPublicRoom));
});
