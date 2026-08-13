import { Server, Socket } from 'socket.io';
import { Room, GameInput } from '../types/index.js';
import { prisma } from '../db/prisma.js';
import { notifyFriendsRoomStatusChanged } from '../services/friends.js';
import { createLogger } from '../utils/logger.js';
import { getMemberRoom } from './guards.js';

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
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:start');
    if (!room) return;

    const playersWithPorts = room.players.filter(p => p.port !== null && p.isReady);
    if (playersWithPorts.length === 0) {
      socket.emit('error', { message: 'At least one player must select a controller port' });
      return;
    }

    // Reset emulationReady for all players when starting a new game
    room.players.forEach(p => {
      p.emulationReady = false;
    });

    room.status = 'playing';
    io.to(data.roomId).emit('room:updated', room);

    await notifyFriendsRoomStatusChanged(io, room.hostId, room.id, 'playing', getUserSocket);

    io.to(room.id).emit('game:started');
    logger.info({ roomId: room.id }, 'Game started (client-side emulation)');
  });

  // Player signals their emulator is ready
  socket.on('game:ready', (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:ready');
    if (!room) return;

    const player = room.players.find(p => p.userId === userId);
    if (!player) return;

    player.emulationReady = true;
    logger.info({ roomId: room.id, player: player.displayName }, 'Player emulator ready');

    // Check if all players with ports are ready
    const playersWithPorts = room.players.filter(p => p.port !== null);
    const allReady = playersWithPorts.every(p => p.emulationReady);

    if (allReady) {
      logger.info({ roomId: room.id }, 'All players ready, sending game:go');
      io.to(room.id).emit('game:go');
    }
  });

  // Game input (no-op for client-side emulation)
  socket.on('game:input', (_data: { roomId: string; input: GameInput & { timestamp?: number } }) => {
    // Kept for backwards compatibility
  });

  // Pause game
  socket.on('game:pause', (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:pause');
    if (!room) return;

    room.status = 'paused';
    io.to(data.roomId).emit('game:paused');
  });

  // Resume game
  socket.on('game:resume', (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:resume');
    if (!room) return;

    room.status = 'playing';
    io.to(data.roomId).emit('game:resumed');
  });

  // Stop game
  socket.on('game:stop', async (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:stop');
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
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:save');
    if (!room) return;

    try {
      // Saves belong to the game's owner. Without this check a guest in the
      // room would create Save rows against the host's game (mirrors the
      // ownership check in game:load).
      const ownedGame = await prisma.game.findFirst({
        where: { id: room.gameId, userId },
        select: { id: true }
      });

      if (!ownedGame) {
        socket.emit('error', { message: 'Not authorized to save this game' });
        return;
      }

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
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:load');
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
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:setSpeed');
    if (!room) return;

    io.to(data.roomId).emit('game:speedChanged', { speed: data.speed });
  });

  // Set target FPS
  socket.on('game:setTargetFPS', (data: { roomId: string; targetFPS: number }) => {
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:setTargetFPS');
    if (!room) return;

    io.to(data.roomId).emit('game:targetFPSChanged', { targetFPS: data.targetFPS });
  });

  // Save SRAM (battery save / in-game save)
  socket.on('game:saveSram', async (data: { roomId: string; sramData: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:saveSram');
    if (!room) return;

    try {
      const sramBuffer = Buffer.from(data.sramData, 'base64');

      await prisma.game.update({
        where: {
          id: room.gameId,
          userId: userId // Ensure user owns the game
        },
        data: {
          sram: sramBuffer,
          sramUpdatedAt: new Date()
        }
      });

      socket.emit('game:sramSaved');
      logger.info({ gameId: room.gameId, size: sramBuffer.length }, 'SRAM saved');
    } catch (error) {
      logger.error({ err: error }, 'Error saving SRAM');
      socket.emit('error', { message: 'Failed to save SRAM' });
    }
  });

  // Load SRAM (battery save / in-game save)
  socket.on('game:loadSram', async (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:loadSram');
    if (!room) return;

    try {
      const game = await prisma.game.findFirst({
        where: {
          id: room.gameId,
          userId: userId // Ensure user owns the game
        },
        select: {
          sram: true,
          sramUpdatedAt: true
        }
      });

      if (!game || !game.sram) {
        socket.emit('game:sramLoaded', { sramData: null });
        return;
      }

      const sramDataBase64 = game.sram.toString('base64');
      socket.emit('game:sramLoaded', {
        sramData: sramDataBase64,
        updatedAt: game.sramUpdatedAt
      });
      logger.info({ gameId: room.gameId, size: game.sram.length }, 'SRAM loaded');
    } catch (error) {
      logger.error({ err: error }, 'Error loading SRAM');
      socket.emit('error', { message: 'Failed to load SRAM' });
    }
  });
}
