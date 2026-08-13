import { Server, Socket } from 'socket.io';
import { Room, RoomPlayer, User, EmulationMode } from '../types/index.js';
import { randomUUID } from 'crypto';
import { getUserKeyConfig } from '../services/user-config.js';
import { notifyFriendsAboutRoom, notifyFriendsRoomStatusChanged, getFriendships } from '../services/friends.js';
import { toPublicRoom } from './room-view.js';
import { createLogger } from '../utils/logger.js';
import { cacheRomForRoom, cleanupRoomCache } from '../services/rom-cache.js';
import { cleanupRoomChecksums } from './sync-handlers.js';
import { cleanupHostReady } from './p2p-handlers.js';
import { prisma } from '../db/prisma.js';

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
    const autoStart = data.autoStart ?? false;

    const room: Room = {
      id: roomId,
      gameId: data.gameId,
      gameTitle: data.gameTitle,
      gameCoverUrl: data.gameCoverUrl,
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
      emulationMode: data.emulationMode ?? 'streaming',
      createdAt: new Date()
    };

    rooms.set(roomId, room);
    socket.join(roomId);

    // Cache ROM for multiplayer access
    try {
      const game = await prisma.game.findUnique({ where: { id: data.gameId } });
      if (game) {
        await cacheRomForRoom(roomId, user.id, game.driveFileId);
        logger.info({ roomId, gameId: data.gameId }, 'ROM cached for room');
      }
    } catch (error) {
      logger.error({ err: error, roomId, gameId: data.gameId }, 'Failed to cache ROM for room');
      // Continue anyway - single player might still work
    }

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

export async function handleLeaveRoom(
  io: Server,
  socket: Socket,
  roomId: string,
  rooms: Map<string, Room>,
  user: User,
  getUserSocket: (id: string) => string | undefined
) {
  const room = rooms.get(roomId);
  if (!room) return;

  const wasHost = room.hostId === user.id;

  room.players = room.players.filter(p => p.userId !== user.id);
  socket.leave(roomId);

  if (room.players.length === 0) {
    await notifyFriendsRoomStatusChanged(io, room.hostId, room.id, 'destroyed', getUserSocket);
    // Clean up per-room state so nothing outlives the room itself
    await cleanupRoomCache(roomId);
    cleanupRoomChecksums(roomId);
    cleanupHostReady(roomId);
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
