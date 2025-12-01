import { Server, Socket } from 'socket.io';
import { Room } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Sync');

interface ChecksumData {
  frame: number;
  checksum: string;
  timestamp: number;
}

// Store checksums per room per player
// roomId -> { hostChecksum, guestChecksum }
const roomChecksums = new Map<string, {
  host?: ChecksumData;
  guest?: ChecksumData;
}>();

export function registerSyncHandlers(
  socket: Socket,
  io: Server,
  userId: string,
  rooms: Map<string, Room>
) {
  // Player reports their checksum
  socket.on('sync:checksum', (data: { roomId: string; frame: number; checksum: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const isHost = room.hostId === userId;
    const role = isHost ? 'HOST' : 'GUEST';

    // Initialize room checksums if needed
    if (!roomChecksums.has(data.roomId)) {
      roomChecksums.set(data.roomId, {});
    }

    const checksums = roomChecksums.get(data.roomId)!;
    const checksumData: ChecksumData = {
      frame: data.frame,
      checksum: data.checksum,
      timestamp: Date.now()
    };

    if (isHost) {
      checksums.host = checksumData;
    } else {
      checksums.guest = checksumData;
    }

    logger.debug({ roomId: data.roomId, role, frame: data.frame, checksum: data.checksum }, 'Checksum received');

    // Check if we have both checksums for similar frames
    if (checksums.host && checksums.guest) {
      const frameDiff = Math.abs(checksums.host.frame - checksums.guest.frame);

      // Only compare if frames are within 10 of each other
      if (frameDiff <= 10) {
        const match = checksums.host.checksum === checksums.guest.checksum;

        if (match) {
          logger.info({
            roomId: data.roomId,
            hostFrame: checksums.host.frame,
            guestFrame: checksums.guest.frame,
            checksum: checksums.host.checksum
          }, '✅ Sync OK');
        } else {
          logger.warn({
            roomId: data.roomId,
            hostFrame: checksums.host.frame,
            guestFrame: checksums.guest.frame,
            hostChecksum: checksums.host.checksum,
            guestChecksum: checksums.guest.checksum
          }, '❌ DESYNC detected');
        }

        // Broadcast result to both players
        io.to(data.roomId).emit('sync:result', {
          match,
          hostFrame: checksums.host.frame,
          guestFrame: checksums.guest.frame,
          hostChecksum: checksums.host.checksum,
          guestChecksum: checksums.guest.checksum
        });

        // Clear after comparison
        checksums.host = undefined;
        checksums.guest = undefined;
      }
    }
  });

  // Clean up when room is destroyed or player leaves
  socket.on('disconnect', () => {
    // Find rooms this user was in and clean up
    rooms.forEach((room, roomId) => {
      if (room.players.some(p => p.userId === userId)) {
        roomChecksums.delete(roomId);
      }
    });
  });
}

// Export for cleanup when room is deleted
export function cleanupRoomChecksums(roomId: string): void {
  roomChecksums.delete(roomId);
}
