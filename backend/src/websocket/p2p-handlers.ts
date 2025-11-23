import { Socket } from 'socket.io';

export function registerP2PHandlers(socket: Socket, displayName: string) {
  // Simple P2P room join
  socket.on('p2p:join', (data: { roomId: string }) => {
    console.log(`🔗 ${displayName} joining P2P room: ${data.roomId}`);
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
    console.log(`📡 Relaying WebRTC signal in room ${data.roomId} from ${socket.id}`);

    socket.to(data.roomId).emit('webrtc:signal', {
      signal: data.signal,
      from: socket.id
    });
  });
}
