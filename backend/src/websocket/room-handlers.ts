import { Server, Socket } from 'socket.io';
import { Room, RoomPlayer, User, EmulationMode } from '../types/index.js';
import { randomUUID } from 'crypto';
import { getUserKeyConfig } from '../services/user-config.js';
import { notifyFriendsAboutRoom, notifyFriendsRoomStatusChanged, getFriendships } from '../services/friends.js';
import { toPublicRoom } from './room-view.js';
import { createLogger } from '../utils/logger.js';
import { cleanupRoomChecksums } from './sync-handlers.js';
import { cleanupHostReady } from './p2p-handlers.js';
import { cleanupZnetRoom } from './znet-handlers.js';
import { getDb } from '../db/sqlite.js';
import { findChecksumOfOwnedGame } from '../db/games.js';

const logger = createLogger('Room');

export function registerRoomHandlers(
  socket: Socket,
  io: Server,
  user: User,
  rooms: Map<string, Room>,
  getUserSocket: (id: string) => string | undefined
) {
  // Create room
  socket.on('room:create', async (data: { gameId: string; gameTitle: string; gameCoverUrl?: string; autoStart?: boolean; emulationMode?: EmulationMode }) => {
    const roomId = randomUUID();
    const userKeyConfig = await getUserKeyConfig(user.id);
    // Read from the host's library rather than trusting the payload: the guest
    // will use this checksum to pick a file off their own disk, so it has to
    // be the one the server recorded.
    const gameCrc32 = findChecksumOfOwnedGame(getDb(), data.gameId, user.id);
    const autoStart = data.autoStart ?? false;

    const room: Room = {
      id: roomId,
      gameId: data.gameId,
      gameTitle: data.gameTitle,
      gameCoverUrl: data.gameCoverUrl,
      gameCrc32: gameCrc32 ?? undefined,
      hostId: user.id,
      createdBy: user.id,
      players: [{
        userId: user.id,
        displayName: user.displayName,
        avatar: user.avatar ?? undefined,
        port: 1, // Always assign creator to player 1
        isReady: true, // Always ready by default
        emulationReady: false,
        keyConfig: userKeyConfig
      }],
      status: autoStart ? 'playing' : 'waiting',
      // Lockstep by default: both players run the same deterministic core and
      // exchange inputs, so a room cannot end up with two machines quietly
      // diverging the way the dual mode does.
      emulationMode: data.emulationMode ?? 'lockstep',
      createdAt: new Date()
    };

    rooms.set(roomId, room);
    socket.join(roomId);

    socket.emit('room:created', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
    notifyFriendsAboutRoom(io, user.id, room, getUserSocket);

    if (autoStart) {
      await notifyFriendsRoomStatusChanged(io, user.id, room.id, 'playing', getUserSocket);
      io.to(roomId).emit('game:started');
      logger.info({ roomId, host: user.displayName }, 'Game auto-started');
    }
  });

  // Join room
  socket.on('room:join', async (data: { roomId: string }) => {
    // A rejoin, including the automatic one after a reconnect, reclaims a seat
    // that is waiting out its grace period.
    if (data?.roomId) cancelScheduledLeave(data.roomId, user.id);
    const room = rooms.get(data.roomId);

    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    const existingPlayer = room.players.find(p => p.userId === user.id);
    if (existingPlayer) {
      socket.join(data.roomId);
      socket.emit('room:updated', room);

      if (room.status === 'playing') {
        socket.emit('game:started');
      }
      return;
    }

    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    const userKeyConfig = await getUserKeyConfig(user.id);

    const player: RoomPlayer = {
      userId: user.id,
      displayName: user.displayName,
      avatar: user.avatar ?? undefined,
      port: 2, // Guest always joins as player 2
      isReady: true, // Always ready by default
      emulationReady: false,
      keyConfig: userKeyConfig
    };

    room.players.push(player);
    socket.join(data.roomId);

    io.to(data.roomId).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);

    if (room.status === 'playing') {
      socket.emit('game:started');
      logger.info({ roomId: room.id, guest: user.displayName }, 'Guest joined as Player 2 (game in progress)');
    }
  });

  // Leave room
  socket.on('room:leave', (data: { roomId: string }) => {
    // Deliberate, so no grace period - and cancel any pending one.
    if (data?.roomId) cancelScheduledLeave(data.roomId, user.id);
    handleLeaveRoom(io, socket, data.roomId, rooms, user, getUserSocket);
  });

  // Select controller port
  socket.on('room:selectPort', (data: { roomId: string; port: 1 | 2 }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const player = room.players.find(p => p.userId === user.id);
    if (!player) return;

    const occupiedPlayer = room.players.find(p => p.port === data.port && p.userId !== user.id);

    if (occupiedPlayer) {
      const otherPort = data.port === 1 ? 2 : 1;
      occupiedPlayer.port = otherPort;
    }

    player.port = data.port;
    player.isReady = true;
    io.to(data.roomId).emit('room:updated', room);
  });

  // Unselect controller port
  socket.on('room:unselectPort', (data: { roomId: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const player = room.players.find(p => p.userId === user.id);
    if (!player) return;

    player.port = null;
    player.isReady = false;
    io.to(data.roomId).emit('room:updated', room);
  });

  // Update key config
  socket.on('room:updateKeyConfig', (data: { roomId: string; keyConfig: any }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const player = room.players.find(p => p.userId === user.id);
    if (!player) return;

    player.keyConfig = data.keyConfig;
    io.to(data.roomId).emit('room:updated', room);
  });

  // Toggle ready
  socket.on('room:toggleReady', (data: { roomId: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const player = room.players.find(p => p.userId === user.id);
    if (!player) return;

    player.isReady = !player.isReady;
    io.to(data.roomId).emit('room:updated', room);
  });

  // Set emulation mode (only room creator can change)
  socket.on('room:setEmulationMode', (data: { roomId: string; emulationMode: EmulationMode }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    // Only the room creator can change the mode
    if (room.createdBy !== user.id) return;

    // Only allow changes in waiting status
    if (room.status !== 'waiting') return;

    room.emulationMode = data.emulationMode;
    io.to(data.roomId).emit('room:updated', room);
    logger.info({ roomId: room.id, mode: data.emulationMode }, 'Emulation mode changed');
  });
}

/**
 * Departures waiting out their grace period, keyed by room and user.
 *
 * A socket that drops is not a player who left. Removing them on the spot
 * destroyed rooms mid-game: the last player's connection blinked, the room was
 * deleted, and when their socket came back a moment later there was nothing to
 * rejoin - every netplay packet from then on was refused as coming from a
 * non-member, while the game itself carried on happily sending them.
 *
 * Emulation saturates the main thread, which makes those blinks routine rather
 * than rare.
 */
const pendingDepartures = new Map<string, NodeJS.Timeout>();

const DISCONNECT_GRACE_MS = 45_000;

const departureKey = (roomId: string, userId: string) => `${roomId}:${userId}`;

/** Removes a player only if they are still gone once the grace period ends. */
export function scheduleLeaveRoom(
  io: Server,
  socket: Socket,
  roomId: string,
  rooms: Map<string, Room>,
  user: User,
  getUserSocket: (id: string) => string | undefined
) {
  const key = departureKey(roomId, user.id);
  clearTimeout(pendingDepartures.get(key));

  pendingDepartures.set(
    key,
    setTimeout(() => {
      pendingDepartures.delete(key);
      logger.info({ roomId, userId: user.id }, 'Grace period elapsed, removing player');
      void handleLeaveRoom(io, socket, roomId, rooms, user, getUserSocket);
    }, DISCONNECT_GRACE_MS)
  );

  logger.debug({ roomId, userId: user.id }, 'Player disconnected, holding their seat');
}

/** Called when the player is back, so their seat is never given up. */
export function cancelScheduledLeave(roomId: string, userId: string) {
  const key = departureKey(roomId, userId);
  const timer = pendingDepartures.get(key);
  if (!timer) return;
  clearTimeout(timer);
  pendingDepartures.delete(key);
  logger.info({ roomId, userId }, 'Player returned within the grace period');
}

/**
 * Holds a restored player's seat for the usual grace period.
 *
 * Called once per player when rooms are read back after a restart, where
 * everyone is disconnected by definition. It deliberately reuses the same
 * timer map as `scheduleLeaveRoom`, so `cancelScheduledLeave` releases it
 * through the ordinary path when the player's socket comes back - a returning
 * player needs no special case.
 */
export function holdRestoredSeat(
  io: Server,
  roomId: string,
  rooms: Map<string, Room>,
  userId: string,
  displayName: string,
  getUserSocket: (id: string) => string | undefined
) {
  const key = departureKey(roomId, userId);
  clearTimeout(pendingDepartures.get(key));

  pendingDepartures.set(
    key,
    setTimeout(() => {
      pendingDepartures.delete(key);
      logger.info({ roomId, userId }, 'Restored player did not come back, removing');
      void handleLeaveRoom(io, null, roomId, rooms, { id: userId, displayName } as User, getUserSocket);
    }, DISCONNECT_GRACE_MS)
  );

  logger.debug({ roomId, userId }, 'Holding a restored seat');
}

export async function handleLeaveRoom(
  io: Server,
  socket: Socket | null,
  roomId: string,
  rooms: Map<string, Room>,
  user: User,
  getUserSocket: (id: string) => string | undefined
) {
  const room = rooms.get(roomId);
  if (!room) return;

  const wasHost = room.hostId === user.id;

  room.players = room.players.filter(p => p.userId !== user.id);
  // Null when the departure comes from a restored room rather than a live
  // socket: after a restart there is no socket to take out of the channel.
  socket?.leave(roomId);

  if (room.players.length === 0) {
    await notifyFriendsRoomStatusChanged(io, room.hostId, room.id, 'destroyed', getUserSocket);
    // Clean up per-room state so nothing outlives the room itself
    cleanupRoomChecksums(roomId);
    cleanupHostReady(roomId);
    cleanupZnetRoom(roomId);
    rooms.delete(roomId);
    io.emit('room:destroyed', { roomId });
  } else {
    logger.debug({ roomId, userId: user.id, displayName: user.displayName, wasHost }, 'Player left room');
    io.to(roomId).emit('player:left', {
      userId: user.id,
      displayName: user.displayName,
      wasHost
    });

    if (wasHost) {
      room.hostId = room.players[0].userId;
      io.to(roomId).emit('host:left');
    }

    io.to(roomId).emit('room:updated', room);
    await broadcastRoomUpdate(io, room, getUserSocket);
  }
}

/**
 * Publishes a room update to the people entitled to see it: the players in the
 * room and the host's friends. This used to be an io.emit, which handed every
 * connected user each room's id and every player's keyConfig.
 */
async function broadcastRoomUpdate(
  io: Server,
  room: Room,
  getUserSocketId: (id: string) => string | undefined
) {
  const payload = toPublicRoom(room);
  const recipients = new Set<string>(room.players.map(p => p.userId));

  for (const friendship of await getFriendships(room.hostId)) {
    recipients.add(
      friendship.initiatorId === room.hostId ? friendship.receiverId : friendship.initiatorId
    );
  }

  for (const userId of recipients) {
    const socketId = getUserSocketId(userId);
    if (socketId) io.to(socketId).emit('room:update', payload);
  }
}
