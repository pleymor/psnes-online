import { Socket, Server } from 'socket.io';
import { Room, User } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { getMemberRoom } from './guards.js';

const logger = createLogger('P2P');

// Track which rooms have hosts ready (for dual emulation mode)
const hostReadyRooms = new Set<string>();

export function registerP2PHandlers(
  socket: Socket,
  user: User,
  io: Server,
  rooms: Map<string, Room>
) {
  // Rooms this socket marked as host-ready, so they can be released on disconnect
  const markedReady = new Set<string>();

  // Simple P2P room join
  socket.on('p2p:join', (data: { roomId: string }) => {
    // Joining the socket.io room grants access to the WebRTC signaling channel
    // and to every room broadcast, so membership is mandatory here.
    const room = getMemberRoom(rooms, data?.roomId, user.id, 'p2p:join');
    if (!room) return;

    logger.debug({ user: user.displayName, roomId: room.id }, 'User joining P2P room');
    socket.join(room.id);

    socket.to(room.id).emit('p2p:peer-joined', {
      socketId: socket.id,
      userId: user.id,
      displayName: user.displayName
    });

    socket.emit('p2p:joined', { roomId: room.id });
  });

  // WebRTC Signaling
  socket.on('webrtc:signal', (data: { roomId: string; signal: any }) => {
    const room = getMemberRoom(rooms, data?.roomId, user.id, 'webrtc:signal');
    if (!room) return;

    logger.debug({ roomId: room.id, socketId: socket.id }, 'Relaying WebRTC signal');

    socket.to(room.id).emit('webrtc:signal', {
      signal: data.signal,
      from: socket.id
    });
  });

  // DUAL MODE: Host signals readiness
  socket.on('p2p:host_ready', (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, user.id, 'p2p:host_ready');
    if (!room) return;

    if (room.hostId !== user.id) {
      logger.warn({ roomId: room.id, userId: user.id }, 'Non-host claimed host readiness');
      return;
    }

    logger.debug({ roomId: room.id }, 'Host signaled ready for P2P');
    hostReadyRooms.add(room.id);
    markedReady.add(room.id);
    // Broadcast to all other clients in the room
    socket.to(room.id).emit('p2p:host_ready', { roomId: room.id });
  });

  // DUAL MODE: Guest checks if host is ready
  socket.on('p2p:check_host_ready', (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, user.id, 'p2p:check_host_ready');
    if (!room) return;

    const isReady = hostReadyRooms.has(room.id);
    logger.debug({ roomId: room.id, isReady }, 'Guest checking if host is ready');
    if (isReady) {
      socket.emit('p2p:host_ready', { roomId: room.id });
    }
  });

  // DUAL MODE: Guest signals ready to receive WebRTC signals
  socket.on('p2p:guest_ready', (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, user.id, 'p2p:guest_ready');
    if (!room) return;

    logger.debug({ roomId: room.id }, 'Guest signaled ready for P2P');
    // Broadcast to host (and any other clients in the room)
    socket.to(room.id).emit('p2p:guest_ready', { roomId: room.id });
  });

  // Cleanup when socket disconnects
  socket.on('disconnect', () => {
    // Release readiness for the rooms this socket actually marked, otherwise a
    // stale entry makes a later guest believe a host is already up.
    for (const roomId of markedReady) {
      hostReadyRooms.delete(roomId);
    }
    markedReady.clear();
  });
}

// Export for cleanup when a room is destroyed
export function cleanupHostReady(roomId: string): void {
  hostReadyRooms.delete(roomId);
}
