import { Server, Socket } from 'socket.io';
import { Room, GameInput } from '../types/index.js';
import { prisma } from '../db/prisma.js';
import { notifyFriendsRoomStatusChanged } from '../services/friends.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Game');

export function registerGameHandlers(
  socket: Socket,
  io: Server,
  userId: string,
  rooms: Map<string, Room>,
  getUserSocket: (id: string) => string | undefined
) {
  // Start game
  socket.on('game:start', async (data: { roomId: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    const playersWithPorts = room.players.filter(p => p.port !== null && p.isReady);
    if (playersWithPorts.length === 0) {
      socket.emit('error', { message: 'At least one player must select a controller port' });
      return;
    }

    room.status = 'playing';
    io.to(data.roomId).emit('room:updated', room);

    await notifyFriendsRoomStatusChanged(io, room.hostId, room.id, 'playing', getUserSocket);

    io.to(room.id).emit('game:started');
    logger.info({ roomId: room.id }, 'Game started (client-side emulation)');
  });

  // Game input (no-op for client-side emulation)
  socket.on('game:input', (_data: { roomId: string; input: GameInput & { timestamp?: number } }) => {
    // Kept for backwards compatibility
  });

  // Pause game
  socket.on('game:pause', (data: { roomId: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    room.status = 'paused';
    io.to(data.roomId).emit('game:paused');
  });

  // Resume game
  socket.on('game:resume', (data: { roomId: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    room.status = 'playing';
    io.to(data.roomId).emit('game:resumed');
  });

  // Stop game
  socket.on('game:stop', async (data: { roomId: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    room.status = 'waiting';
    room.players.forEach(p => {
      if (p.port !== null) {
        p.isReady = true;
      } else {
        p.isReady = false;
      }
    });
    io.to(data.roomId).emit('game:stopped');
    io.to(data.roomId).emit('room:updated', room);
    logger.info({ roomId: room.id }, 'Game stopped (client-side emulation)');
  });

  // Save state
  socket.on('game:save', async (data: { roomId: string; slotNumber: number; name: string; saveData?: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    try {
      const existingSave = await prisma.save.findFirst({
        where: {
          gameId: room.gameId,
          slotNumber: data.slotNumber,
          game: {
            userId: userId
          }
        }
      });

      const saveDataBuffer = data.saveData
        ? Buffer.from(data.saveData, 'base64')
        : Buffer.alloc(0);

      if (existingSave) {
        await prisma.save.update({
          where: { id: existingSave.id },
          data: {
            name: data.name,
            data: saveDataBuffer,
            updatedAt: new Date()
          }
        });
      } else {
        await prisma.save.create({
          data: {
            gameId: room.gameId,
            slotNumber: data.slotNumber,
            name: data.name,
            data: saveDataBuffer,
            screenshot: null
          }
        });
      }

      socket.emit('game:saved', { slotNumber: data.slotNumber });
      logger.info({ saveName: data.name, slot: data.slotNumber, gameId: room.gameId }, 'Save created');
    } catch (error) {
      logger.error({ err: error }, 'Error saving game state');
      socket.emit('error', { message: 'Failed to save game' });
    }
  });

  // Load state
  socket.on('game:load', async (data: { roomId: string; saveId: string }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    try {
      const save = await prisma.save.findUnique({
        where: { id: data.saveId },
        include: { game: true }
      });

      if (!save) {
        socket.emit('error', { message: 'Save not found' });
        return;
      }

      if (save.game.userId !== userId) {
        socket.emit('error', { message: 'Not authorized to load this save' });
        return;
      }

      const saveDataBase64 = save.data.toString('base64');

      io.to(data.roomId).emit('game:loaded', {
        saveId: data.saveId,
        saveData: saveDataBase64,
        slotNumber: save.slotNumber,
        name: save.name
      });
      logger.info({ saveName: save.name, slot: save.slotNumber, gameId: room.gameId }, 'Save loaded');
    } catch (error) {
      logger.error({ err: error }, 'Error loading game state');
      socket.emit('error', { message: 'Failed to load game' });
    }
  });

  // Set emulation speed
  socket.on('game:setSpeed', (data: { roomId: string; speed: number }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    io.to(data.roomId).emit('game:speedChanged', { speed: data.speed });
  });

  // Set target FPS
  socket.on('game:setTargetFPS', (data: { roomId: string; targetFPS: number }) => {
    const room = rooms.get(data.roomId);
    if (!room) return;

    io.to(data.roomId).emit('game:targetFPSChanged', { targetFPS: data.targetFPS });
  });
}
