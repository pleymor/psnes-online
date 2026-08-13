import { Server, Socket } from 'socket.io';
import { Room, User } from '../types/index.js';
import { prisma } from '../db/prisma.js';
import { notifyFriendsStatusChanged, getOnlineFriends } from '../services/friends.js';
import { registerRoomHandlers, handleLeaveRoom } from './room-handlers.js';
import { registerGameHandlers } from './game-handlers.js';
import { registerP2PHandlers } from './p2p-handlers.js';
import { registerSyncHandlers } from './sync-handlers.js';
import { toPublicRoom, visibleRoomsFor } from './room-view.js';
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

/**
 * Wraps socket.on so a throwing or rejecting handler is logged instead of
 * escalating to an unhandledRejection that would terminate the process.
 * Installed once per connection, before any handler is registered, so it
 * covers every event including ones added later.
 */
function protectHandlers(socket: Socket) {
  const originalOn = socket.on.bind(socket);
  (socket as any).on = (event: string, handler: (...args: any[]) => unknown) =>
    originalOn(event, (...args: any[]) => {
      try {
        const result = handler(...args);
        if (result instanceof Promise) {
          result.catch(err => logger.error({ err, event }, 'Socket handler rejected'));
        }
      } catch (err) {
        logger.error({ err, event }, 'Socket handler threw');
      }
    });
}

export function initializeWebSocket(io: Server) {
  ioInstance = io;

  io.on('connection', async (socket: Socket) => {
    try {
      await handleConnection(io, socket);
    } catch (err) {
      logger.error({ err, socketId: socket.id }, 'Connection setup failed');
      socket.disconnect();
    }
  });

  return { rooms };
}

async function handleConnection(io: Server, socket: Socket) {
  logger.debug({ socketId: socket.id }, 'Client connected');

  protectHandlers(socket);

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

  // Register every handler before awaiting anything else. socket.io discards
  // events that arrive with no listener attached, so any await placed before
  // this point is a window in which a client's first emit is silently dropped.
  socket.on('friends:getOnlineStatus', async () => {
    const onlineFriends = await getOnlineFriends(user.id, userSockets);
    socket.emit('friends:online', onlineFriends);
  });

  registerRoomHandlers(socket, io, user, rooms, getUserSocket);
  registerGameHandlers(socket, io, user.id, rooms, getUserSocket);
  registerP2PHandlers(socket, user, io, rooms);
  registerSyncHandlers(socket, io, user.id, rooms);

  // Send current rooms list, scoped the same way as GET /api/rooms —
  // broadcasting every room here would hand out room ids (and previously
  // every player's keyConfig) to anyone who merely opened a socket.
  // Doubles as the "setup finished" signal for clients.
  const visible = await visibleRoomsFor(user.id, rooms);
  socket.emit('rooms:list', visible.map(toPublicRoom));

  // Notify friends that this user is now online
  await notifyFriendsStatusChanged(io, user.id, true, getUserSocket);

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
}
