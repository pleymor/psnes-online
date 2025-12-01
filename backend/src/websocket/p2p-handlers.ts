import { Socket, Server } from 'socket.io';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('P2P');

// Track which rooms have hosts ready (for dual emulation mode)
const hostReadyRooms = new Set<string>();

export function registerP2PHandlers(socket: Socket, displayName: string, io: Server) {
  // Simple P2P room join
  socket.on('p2p:join', (data: { roomId: string }) => {
    logger.debug({ user: displayName, roomId: data.roomId }, 'User joining P2P room');
    socket.join(data.roomId);

    socket.to(data.roomId).emit('p2p:peer-joined', {
      socketId: socket.id,
      userId: (socket as any).userId,
      displayName: displayName
    });

    socket.emit('p2p:joined', { roomId: data.roomId });
  });

  // WebRTC Signaling
  socket.on('webrtc:signal', (data: { roomId: string; signal: any }) => {
    logger.debug({ roomId: data.roomId, socketId: socket.id }, 'Relaying WebRTC signal');

    socket.to(data.roomId).emit('webrtc:signal', {
      signal: data.signal,
      from: socket.id
    });
  });

  // DUAL MODE: Host signals readiness
  socket.on('p2p:host_ready', (data: { roomId: string }) => {
    logger.debug({ roomId: data.roomId }, 'Host signaled ready for P2P');
    hostReadyRooms.add(data.roomId);
    // Broadcast to all other clients in the room
    socket.to(data.roomId).emit('p2p:host_ready', { roomId: data.roomId });
  });

  // DUAL MODE: Guest checks if host is ready
  socket.on('p2p:check_host_ready', (data: { roomId: string }) => {
    const isReady = hostReadyRooms.has(data.roomId);
    logger.debug({ roomId: data.roomId, isReady }, 'Guest checking if host is ready');
    if (isReady) {
      socket.emit('p2p:host_ready', { roomId: data.roomId });
    }
  });

  // DUAL MODE: Guest signals ready to receive WebRTC signals
  socket.on('p2p:guest_ready', (data: { roomId: string }) => {
    logger.debug({ roomId: data.roomId }, 'Guest signaled ready for P2P');
    // Broadcast to host (and any other clients in the room)
    socket.to(data.roomId).emit('p2p:guest_ready', { roomId: data.roomId });
  });

  // Cleanup when socket disconnects
  socket.on('disconnect', () => {
    // Note: We don't remove from hostReadyRooms here as we don't know which rooms
    // this socket was host of. In production, you'd want to track this properly.
  });
}
