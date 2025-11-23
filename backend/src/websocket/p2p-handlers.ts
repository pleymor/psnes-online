import { Socket } from 'socket.io';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('P2P');

export function registerP2PHandlers(socket: Socket, displayName: string) {
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
}
