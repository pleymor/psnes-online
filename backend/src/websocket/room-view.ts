import { Room } from '../types/index.js';
import { getFriendships } from '../services/friends.js';
import { getDb } from '../db/sqlite.js';
import { findGameByChecksum } from '../db/games.js';
import { romAvailability } from '../rooms/rom-availability.js';

/**
 * Room representation safe to send to a client: drops per-player `keyConfig`,
 * which is a private input setting with no use outside the room it belongs to.
 *
 * Synchronous on purpose. `visible.map(toPublicRoom)` is how every call site
 * uses this (`websocket/index.ts`, `room-handlers.ts`, `api/rooms.ts`) - making
 * it `async` would turn that into an array of promises, which `socket.emit`
 * and `res.json` serialise as a list of `{}` with no error anywhere. Nothing
 * here needs to be async: better-sqlite3 is synchronous, so `getDb()` plus a
 * plain call is enough.
 */
export function toPublicRoom(room: Room) {
  const db = getDb();
  return {
    id: room.id,
    // No requireGame() here on purpose: a room can exist before a game is
    // chosen, and this view has to describe that room too, undefined gameId
    // and gameTitle included.
    gameId: room.gameId,
    gameTitle: room.gameTitle,
    gameCoverUrl: room.gameCoverUrl,
    gameCrc32: room.gameCrc32,
    hostId: room.hostId,
    createdBy: room.createdBy,
    status: room.status,
    emulationMode: room.emulationMode,
    createdAt: room.createdAt,
    // One indexed lookup per player, not per view construction: two players
    // and a unique index on Game(userId, crc32) keep this cheap. Never ask the
    // client whether it has the ROM - that is a question it would answer on
    // its own honour.
    players: room.players.map(p => ({
      userId: p.userId,
      displayName: p.displayName,
      avatar: p.avatar,
      port: p.port,
      isReady: p.isReady,
      rom: romAvailability({
        gameCrc32: room.gameCrc32,
        playerOwnsChecksum: room.gameCrc32
          ? findGameByChecksum(db, p.userId, room.gameCrc32) !== null
          : false
      })
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
