import { Server, Socket } from 'socket.io';
import { Room, User } from '../types/index.js';
import { prisma } from '../db/prisma.js';
import { notifyFriendsStatusChanged, getOnlineFriends } from '../services/friends.js';
import { registerRoomHandlers, handleLeaveRoom } from './room-handlers.js';
import { registerGameHandlers } from './game-handlers.js';
import { registerP2PHandlers } from './p2p-handlers.js';
import { registerSyncHandlers } from './sync-handlers.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('WebSocket');

const rooms = new Map<string, Room>();
const userSockets = new Map<string, string>(); // userId -> socketId
const socketUsers = new Map<string, User>(); // socketId -> User

// Export io instance for use in other modules
let ioInstance: Server | null = null;

export function getIO(): Server | null {
  return ioInstance;
}

export function getUserSocket(userId: string): string | undefined {
  return userSockets.get(userId);
}

export function getRooms(): Map<string, Room> {
  return rooms;
}

export function initializeWebSocket(io: Server) {
  ioInstance = io;

  io.on('connection', async (socket: Socket) => {
    logger.debug({ socketId: socket.id }, 'Client connected');

    const userId = (socket.request as any).session?.passport?.user;
    if (!userId) {
      socket.disconnect();
      return;
    }

    // Load full user data from database (WebSocket doesn't run deserializeUser)
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      logger.error({ userId }, 'User not found');
      socket.disconnect();
      return;
    }

    logger.info({ user: user.displayName, email: user.email }, 'User connected');

    socketUsers.set(socket.id, user);
    userSockets.set(user.id, socket.id);

    // Send current rooms list
    socket.emit('rooms:list', Array.from(rooms.values()));

    // Notify friends that this user is now online
    await notifyFriendsStatusChanged(io, user.id, true, getUserSocket);

    // Handle request for online friends status
    socket.on('friends:getOnlineStatus', async () => {
      const onlineFriends = await getOnlineFriends(user.id, userSockets);
      socket.emit('friends:online', onlineFriends);
    });

    // Register event handlers
    registerRoomHandlers(socket, io, user, rooms, getUserSocket);
    registerGameHandlers(socket, io, user.id, rooms, getUserSocket);
    registerP2PHandlers(socket, user, io, rooms);
    registerSyncHandlers(socket, io, user.id, rooms);

    // Disconnect
    socket.on('disconnect', async () => {
      logger.debug({ socketId: socket.id, user: user.displayName }, 'Client disconnected');

      await notifyFriendsStatusChanged(io, user.id, false, getUserSocket);

      // Find and leave all rooms
      rooms.forEach((room, roomId) => {
        if (room.players.some(p => p.userId === user.id)) {
          handleLeaveRoom(io, socket, roomId, rooms, user, getUserSocket);
        }
      });

      // Clean up user mappings
      socketUsers.delete(socket.id);
      userSockets.delete(user.id);
    });
  });

  return { rooms };
}
