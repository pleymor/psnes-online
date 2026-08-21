import { Server, Socket } from 'socket.io';
import { Room, GameInput } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { findOwnedGameId, saveSram, findSram } from '../db/games.js';
import { findSaveWithGame, createSave, updateSaveData, nextFreeSlot, findSaveOwnerId } from '../db/saves.js';
import { notifyFriendsRoomStatusChanged } from '../services/friends.js';
import { createLogger } from '../utils/logger.js';
import { getMemberRoom } from './guards.js';
import { requireGame } from '../rooms/require-game.js';

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
  socket.on('game:save', async (data: { roomId: string; saveId?: string; name: string; saveData?: string; screenshot?: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:save');
    if (!room) return;

    const game = requireGame(room);
    if (!game) {
      socket.emit('error', { message: 'No game has been chosen in this room yet.' });
      return;
    }

    try {
      const db = getDb();
      // Saves belong to the game's owner. Without this check a guest in the
      // room would create Save rows against the host's game (mirrors the
      // ownership check in game:load).
      const ownedGameId = findOwnedGameId(db, game.gameId, userId);

      if (!ownedGameId) {
        socket.emit('error', { message: 'Not authorized to save this game' });
        return;
      }

      const saveDataBuffer = data.saveData
        ? Buffer.from(data.saveData, 'base64')
        : Buffer.alloc(0);
      const screenshot = data.screenshot ?? null;

      // Overwriting names a save by id, because the player picks it from a
      // list of thumbnails rather than choosing a slot number. The id came
      // from the client, so it is checked against this user rather than
      // trusted - the room's game being theirs does not make every save id
      // theirs.
      if (data.saveId) {
        const owner = findSaveOwnerId(db, data.saveId);
        if (owner !== userId) {
          socket.emit('error', { message: 'Not authorized to overwrite this save' });
          return;
        }
        updateSaveData(db, data.saveId, data.name, saveDataBuffer, screenshot);
        socket.emit('game:saved', { saveId: data.saveId });
        logger.info({ saveName: data.name, saveId: data.saveId, gameId: game.gameId }, 'Save overwritten');
        return;
      }

      // The slot picker is gone, so the server assigns the number.
      const created = createSave(db, {
        gameId: game.gameId,
        slotNumber: nextFreeSlot(db, game.gameId),
        name: data.name,
        data: saveDataBuffer,
        screenshot
      });

      socket.emit('game:saved', { saveId: created.id });
      logger.info({ saveName: data.name, saveId: created.id, gameId: game.gameId }, 'Save created');
    } catch (error) {
      logger.error({ err: error }, 'Error saving game state');
      socket.emit('error', { message: 'Failed to save game' });
    }
  });

  // Load state
  socket.on('game:load', async (data: { roomId: string; saveId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:load');
    if (!room) return;

    const game = requireGame(room);
    if (!game) {
      socket.emit('error', { message: 'No game has been chosen in this room yet.' });
      return;
    }

    try {
      const save = findSaveWithGame(getDb(), data.saveId);

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
      logger.info({ saveName: save.name, slot: save.slotNumber, gameId: game.gameId }, 'Save loaded');
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

    const game = requireGame(room);
    if (!game) {
      socket.emit('error', { message: 'No game has been chosen in this room yet.' });
      return;
    }

    try {
      const sramBuffer = Buffer.from(data.sramData, 'base64');

      saveSram(getDb(), game.gameId, userId, sramBuffer);

      socket.emit('game:sramSaved');
      logger.info({ gameId: game.gameId, size: sramBuffer.length }, 'SRAM saved');
    } catch (error) {
      logger.error({ err: error }, 'Error saving SRAM');
      socket.emit('error', { message: 'Failed to save SRAM' });
    }
  });

  // Load SRAM (battery save / in-game save)
  socket.on('game:loadSram', async (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:loadSram');
    if (!room) return;

    const game = requireGame(room);
    if (!game) {
      socket.emit('error', { message: 'No game has been chosen in this room yet.' });
      return;
    }

    try {
      const stored = findSram(getDb(), game.gameId, userId);

      if (!stored) {
        socket.emit('game:sramLoaded', { sramData: null });
        return;
      }

      const sramDataBase64 = stored.sram.toString('base64');
      socket.emit('game:sramLoaded', {
        sramData: sramDataBase64,
        updatedAt: stored.sramUpdatedAt
      });
      logger.info({ gameId: game.gameId, size: stored.sram.length }, 'SRAM loaded');
    } catch (error) {
      logger.error({ err: error }, 'Error loading SRAM');
      socket.emit('error', { message: 'Failed to load SRAM' });
    }
  });
}
