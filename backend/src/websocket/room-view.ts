import { Room } from '../types/index.js';
import { getFriendships } from '../services/friends.js';

/**
 * Room representation safe to send to a client: drops per-player `keyConfig`,
 * which is a private input setting with no use outside the room it belongs to.
 */
export function toPublicRoom(room: Room) {
  return {
    id: room.id,
    gameId: room.gameId,
    gameTitle: room.gameTitle,
    gameCoverUrl: room.gameCoverUrl,
    gameCrc32: room.gameCrc32,
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

/** User ids whose rooms `userId` is allowed to see: themselves plus friends. */
export async function roomAudienceFor(userId: string): Promise<Set<string>> {
  const friendships = await getFriendships(userId);
  const ids = new Set<string>([userId]);
  for (const friendship of friendships) {
    ids.add(friendship.initiatorId === userId ? friendship.receiverId : friendship.initiatorId);
  }
  return ids;
}

export function isRoomVisibleTo(room: Room, userId: string, audience: Set<string>): boolean {
  return (
    room.players.some(p => p.userId === userId) ||
    audience.has(room.createdBy) ||
    audience.has(room.hostId)
  );
}

/** Active rooms `userId` may see: their own, plus their friends'. */
export async function visibleRoomsFor(
  userId: string,
  rooms: Map<string, Room>
): Promise<Room[]> {
  const audience = await roomAudienceFor(userId);
  return Array.from(rooms.values()).filter(room => isRoomVisibleTo(room, userId, audience));
}
