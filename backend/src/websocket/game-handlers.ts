import { Server, Socket } from 'socket.io';
import { Room, GameInput } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { findOwnedGameId, saveSram, findSram } from '../db/games.js';
import { findSaveWithGame, createSave, updateSaveData, nextFreeSlot, findSaveOwnerId } from '../db/saves.js';
import { notifyFriendsRoomStatusChanged } from '../services/friends.js';
import { createLogger } from '../utils/logger.js';
import { getMemberRoom } from './guards.js';
import { requireGame } from '../rooms/require-game.js';
import { saveSuitsRoom } from '../rooms/save-suits-room.js';
import { findOwnGameIdForRoom } from '../rooms/own-game.js';
import { onlinePlayers } from '../rooms/online-players.js';

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

    /*
     * The eleventh guard, and the one whose absence costs the most.
     *
     * Ten handlers ask `requireGame`; this one did not, and it is the only one
     * that moves the room out of `waiting`. Starting with no game left both
     * screens on a branch that renders nothing, with `room:choose-game` now
     * refusing because the status had changed and no quit button anywhere:
     * the only way out was editing the URL. The client disables the button and
     * `room:create` refuses `autoStart` without a game, so a crafted client is
     * what it takes - which is reason to guard it, not to leave it open.
     */
    if (!requireGame(room)) {
      socket.emit('error', { message: 'No game has been chosen in this room yet.' });
      return;
    }

    const seated = room.players.filter(p => p.port !== null && p.isReady);
    if (seated.length === 0) {
      socket.emit('error', { message: 'At least one player must select a controller port' });
      return;
    }

    /*
     * A seat is not a presence.
     *
     * A member who closed their tab keeps their port - it is theirs, and giving
     * it away is the thing this release exists to stop - so `seated` says
     * nothing about whether they are here. Lockstep waits for both cores, so
     * starting without them hangs both screens with no error and no way out but
     * the URL bar. There is no message for that failure; this refusal is it.
     */
    if (seated.some(p => p.online !== true)) {
      socket.emit('error', { message: 'A player is away. Wait for them to come back before starting.' });
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
    // Online, deliberately: an away member holding a port would never report
    // its emulator ready, so `game:go` would never be sent and the start would
    // stall in silence.
    const seatedAndHere = onlinePlayers(room).filter(p => p.port !== null);
    const allReady = seatedAndHere.length > 0 && seatedAndHere.every(p => p.emulationReady);

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

      // Owning the save was the only thing checked here, so a save from a
      // different game reached the emulator and produced a machine in a state
      // that never existed. Matched on the checksum rather than the game id:
      // each player has their own Game row for the same ROM, so a guest's save
      // never shares the room's gameId.
      if (!saveSuitsRoom(room.gameCrc32, save.game.crc32)) {
        socket.emit('error', { message: 'That save belongs to a different game' });
        logger.warn(
          { saveId: data.saveId, roomCrc32: room.gameCrc32, saveCrc32: save.game.crc32 },
          'Refused a save that does not belong to the room game'
        );
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

    if (!requireGame(room)) {
      socket.emit('error', { message: 'No game has been chosen in this room yet.' });
      return;
    }

    try {
      const db = getDb();
      /*
       * The writer's own row, resolved here rather than taken from the room.
       *
       * `room.gameId` belongs to whoever chose the game, and since the guest
       * can choose from his own library that is routinely not the host - who
       * is the one machine that persists. Combining the room's id with the
       * caller's own id matched no row at all, and the player was told it
       * saved.
       */
      const ownGameId = findOwnGameIdForRoom(db, room, userId);
      if (!ownGameId) {
        socket.emit('error', { message: 'You do not have a copy of this game, so it cannot be saved.' });
        return;
      }

      const sramBuffer = Buffer.from(data.sramData, 'base64');

      // An update that changed nothing is a failure, whatever it looks like.
      // Acknowledging one is what cost an hour of play.
      if (saveSram(db, ownGameId, userId, sramBuffer) === 0) {
        logger.warn({ gameId: ownGameId, userId }, 'SRAM write touched no row');
        socket.emit('error', { message: 'Your battery save could not be written.' });
        return;
      }

      socket.emit('game:sramSaved');
      logger.info({ gameId: ownGameId, size: sramBuffer.length }, 'SRAM saved');
    } catch (error) {
      logger.error({ err: error }, 'Error saving SRAM');
      socket.emit('error', { message: 'Failed to save SRAM' });
    }
  });

  // Load SRAM (battery save / in-game save)
  socket.on('game:loadSram', async (data: { roomId: string }) => {
    const room = getMemberRoom(rooms, data?.roomId, userId, 'game:loadSram');
    if (!room) return;

    if (!requireGame(room)) {
      socket.emit('error', { message: 'No game has been chosen in this room yet.' });
      return;
    }

    try {
      const db = getDb();
      // The same resolution as the write, for the same reason: reading the
      // room's row would have found nothing and reported "no battery save",
      // and the cart would have booted empty over an existing one.
      const ownGameId = findOwnGameIdForRoom(db, room, userId);
      if (!ownGameId) {
        // Distinct from "no battery yet", which is an answer. Having no copy
        // of the cart at all is a refusal, and the player has to see it.
        socket.emit('error', { message: 'You do not have a copy of this game, so its save cannot be read.' });
        return;
      }

      const stored = findSram(db, ownGameId, userId);

      if (!stored) {
        socket.emit('game:sramLoaded', { sramData: null });
        return;
      }

      const sramDataBase64 = stored.sram.toString('base64');
      socket.emit('game:sramLoaded', {
        sramData: sramDataBase64,
        updatedAt: stored.sramUpdatedAt
      });
      logger.info({ gameId: ownGameId, size: stored.sram.length }, 'SRAM loaded');
    } catch (error) {
      logger.error({ err: error }, 'Error loading SRAM');
      socket.emit('error', { message: 'Failed to load SRAM' });
    }
  });
}
