import { Server, Socket } from 'socket.io';
import { Room, RoomPlayer, User } from '../types/index.js';
import { randomUUID } from 'crypto';
import { getUserKeyConfig } from '../services/user-config.js';
import { notifyFriendsAboutRoom, notifyFriendsRoomStatusChanged } from '../services/friends.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Room');

export function registerRoomHandlers(
  socket: Socket,
  io: Server,
  user: User,
  rooms: Map<string, Room>,
  getUserSocket: (id: string) => string | undefined
) {
  // Create room
  socket.on('room:create', async (data: { gameId: string; gameTitle: string; autoStart?: boolean }) => {
    const roomId = randomUUID();
    const userKeyConfig = await getUserKeyConfig(user.id);
    const autoStart = data.autoStart ?? false;

    const room: Room = {
      id: roomId,
      gameId: data.gameId,
      gameTitle: data.gameTitle,
      hostId: user.id,
      players: [{
        userId: user.id,
        displayName: user.displayName,
        avatar: user.avatar ?? undefined,
        port: autoStart ? 1 : null,
        isReady: autoStart,
        keyConfig: userKeyConfig
      }],
      status: autoStart ? 'playing' : 'waiting',
      createdAt: new Date()
    };

    rooms.set(roomId, room);
    socket.join(roomId);

    socket.emit('room:created', room);
    broadcastRoomUpdate(io, room);
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
    const autoAssignPort = room.status === 'playing' ? 2 : null;

    const player: RoomPlayer = {
      userId: user.id,
      displayName: user.displayName,
      avatar: user.avatar ?? undefined,
      port: autoAssignPort,
      isReady: autoAssignPort !== null,
      keyConfig: userKeyConfig
    };

    room.players.push(player);
    socket.join(data.roomId);

    io.to(data.roomId).emit('room:updated', room);
    broadcastRoomUpdate(io, room);

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
    broadcastRoomUpdate(io, room);
  }
}

function broadcastRoomUpdate(io: Server, room: Room) {
  io.emit('room:update', room);
}
