import { Room } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Guard');

/**
 * Resolves a room only if the caller is currently one of its players.
 *
 * Room ids are discoverable (they are handed out by `GET /api/rooms` and by
 * friend notifications), so every room-scoped socket event has to prove
 * membership rather than just proving the room exists. Returns null and logs
 * when the caller is not a member, so handlers can bail out uniformly.
 */
export function getMemberRoom(
  rooms: Map<string, Room>,
  roomId: string | undefined,
  userId: string,
  event: string
): Room | null {
  if (!roomId) return null;

  const room = rooms.get(roomId);
  if (!room) return null;

  if (!room.players.some(p => p.userId === userId)) {
    logger.warn({ roomId, userId, event }, 'Rejected room event from non-member');
    return null;
  }

  return room;
}
