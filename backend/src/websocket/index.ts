import { Server, Socket } from 'socket.io';
import { RedisClientType } from 'redis';
import { Room, RoomPlayer, User, GameInput } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import { EmulatorManager } from '../emulator/manager.js';

const rooms = new Map<string, Room>();
const userSockets = new Map<string, string>(); // userId -> socketId
const socketUsers = new Map<string, User>(); // socketId -> User

export function initializeWebSocket(io: Server) {
  const emulatorManager = new EmulatorManager();

  io.on('connection', async (socket: Socket) => {
    console.log('Client connected:', socket.id);

    const user = (socket.request as any).session?.passport?.user;
    if (!user) {
      socket.disconnect();
      return;
    }

    socketUsers.set(socket.id, user);
    userSockets.set(user.id, socket.id);

    // Send current rooms list
    socket.emit('rooms:list', Array.from(rooms.values()));

    // Get online friends
    const onlineFriends = await getOnlineFriends(user.id);
    socket.emit('friends:online', onlineFriends);

    // Create room
    socket.on('room:create', async (data: { gameId: string; gameTitle: string }) => {
      const roomId = uuidv4();

      const room: Room = {
        id: roomId,
        gameId: data.gameId,
        gameTitle: data.gameTitle,
        hostId: user.id,
        players: [{
          userId: user.id,
          displayName: user.displayName,
          avatar: user.avatar,
          port: null,
          isReady: false,
          keyConfig: getDefaultKeyConfig()
        }],
        status: 'waiting',
        createdAt: new Date()
      };

      rooms.set(roomId, room);
      socket.join(roomId);

      socket.emit('room:created', room);
      broadcastRoomUpdate(io, room);
      notifyFriendsAboutRoom(io, user.id, room);
    });

    // Join room
    socket.on('room:join', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);

      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }

      // Check if user is already in the room
      const existingPlayer = room.players.find(p => p.userId === user.id);
      if (existingPlayer) {
        // User already in room (e.g., room creator), just send current state
        socket.join(data.roomId);
        socket.emit('room:updated', room);
        return;
      }

      if (room.players.length >= 2) {
        socket.emit('error', { message: 'Room is full' });
        return;
      }

      if (room.status === 'playing') {
        socket.emit('error', { message: 'Game already in progress' });
        return;
      }

      const player: RoomPlayer = {
        userId: user.id,
        displayName: user.displayName,
        avatar: user.avatar,
        port: null,
        isReady: false,
        keyConfig: getDefaultKeyConfig()
      };

      room.players.push(player);
      socket.join(data.roomId);

      io.to(data.roomId).emit('room:updated', room);
      broadcastRoomUpdate(io, room);
    });

    // Leave room
    socket.on('room:leave', (data: { roomId: string }) => {
      handleLeaveRoom(io, socket, data.roomId, emulatorManager);
    });

    // Select controller port
    socket.on('room:selectPort', (data: { roomId: string; port: 1 | 2 }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      const player = room.players.find(p => p.userId === user.id);
      if (!player) return;

      // Check if port is already taken
      const occupiedPlayer = room.players.find(p => p.port === data.port && p.userId !== user.id);

      if (occupiedPlayer) {
        // Swap ports
        const otherPort = data.port === 1 ? 2 : 1;
        occupiedPlayer.port = otherPort;
      }

      player.port = data.port;
      io.to(data.roomId).emit('room:updated', room);
    });

    // Update key config
    socket.on('room:updateKeyConfig', (data: { roomId: string; keyConfig: any }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      const player = room.players.find(p => p.userId === user.id);
      if (!player) return;

      player.keyConfig = data.keyConfig;
      io.to(data.roomId).emit('room:updated', room);
    });

    // Toggle ready
    socket.on('room:toggleReady', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      const player = room.players.find(p => p.userId === user.id);
      if (!player) return;

      player.isReady = !player.isReady;
      io.to(data.roomId).emit('room:updated', room);
    });

    // Start game
    socket.on('game:start', async (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      // Check if all players are ready and have ports assigned
      const playersWithPorts = room.players.filter(p => p.port !== null);
      if (playersWithPorts.length === 0) {
        socket.emit('error', { message: 'At least one player must select a controller port' });
        return;
      }

      room.status = 'playing';
      io.to(data.roomId).emit('room:updated', room);

      // Start emulator
      try {
        await emulatorManager.startEmulator(room.id, room.gameId);

        // Start streaming
        emulatorManager.on(`frame:${room.id}`, (frameData) => {
          io.to(room.id).emit('game:frame', frameData);
        });

        emulatorManager.on(`audio:${room.id}`, (audioData) => {
          io.to(room.id).emit('game:audio', audioData);
        });

        io.to(room.id).emit('game:started');
      } catch (error) {
        console.error('Failed to start emulator:', error);
        socket.emit('error', { message: 'Failed to start game' });
        room.status = 'waiting';
      }
    });

    // Game input
    socket.on('game:input', (data: { roomId: string; input: GameInput }) => {
      emulatorManager.handleInput(data.roomId, data.input);
    });

    // Pause game
    socket.on('game:pause', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      emulatorManager.pauseEmulator(room.id);
      room.status = 'paused';
      io.to(data.roomId).emit('game:paused');
    });

    // Resume game
    socket.on('game:resume', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      emulatorManager.resumeEmulator(room.id);
      room.status = 'playing';
      io.to(data.roomId).emit('game:resumed');
    });

    // Stop game
    socket.on('game:stop', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      emulatorManager.stopEmulator(room.id);
      room.status = 'waiting';
      room.players.forEach(p => p.isReady = false);
      io.to(data.roomId).emit('game:stopped');
      io.to(data.roomId).emit('room:updated', room);
    });

    // Save state
    socket.on('game:save', async (data: { roomId: string; slotNumber: number; name: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      try {
        await emulatorManager.saveState(room.id, room.gameId, user.id, data.slotNumber, data.name);
        socket.emit('game:saved', { slotNumber: data.slotNumber });
      } catch (error) {
        socket.emit('error', { message: 'Failed to save game' });
      }
    });

    // Load state
    socket.on('game:load', async (data: { roomId: string; saveId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      try {
        await emulatorManager.loadState(room.id, data.saveId);
        io.to(data.roomId).emit('game:loaded', { saveId: data.saveId });
      } catch (error) {
        socket.emit('error', { message: 'Failed to load game' });
      }
    });

    // Set emulation speed
    socket.on('game:setSpeed', (data: { roomId: string; speed: number }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      emulatorManager.setEmulatorSpeed(room.id, data.speed);
      io.to(data.roomId).emit('game:speedChanged', { speed: data.speed });
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);

      // Find and leave all rooms
      rooms.forEach((room, roomId) => {
        if (room.players.some(p => p.userId === user.id)) {
          handleLeaveRoom(io, socket, roomId, emulatorManager);
        }
      });

      socketUsers.delete(socket.id);
      userSockets.delete(user.id);

      // Notify friends
      broadcastOnlineStatus(io, user.id);
    });
  });

  return { rooms, emulatorManager };
}

function handleLeaveRoom(
  io: Server,
  socket: Socket,
  roomId: string,
  emulatorManager: EmulatorManager
) {
  const room = rooms.get(roomId);
  if (!room) return;

  const user = socketUsers.get(socket.id);
  if (!user) return;

  room.players = room.players.filter(p => p.userId !== user.id);
  socket.leave(roomId);

  if (room.players.length === 0) {
    // Room is empty, destroy it
    emulatorManager.stopEmulator(roomId);
    rooms.delete(roomId);
    io.emit('room:destroyed', { roomId });
  } else {
    // If host left, assign new host
    if (room.hostId === user.id) {
      room.hostId = room.players[0].userId;
    }

    io.to(roomId).emit('room:updated', room);
    broadcastRoomUpdate(io, room);
  }
}

function broadcastRoomUpdate(io: Server, room: Room) {
  io.emit('room:update', room);
}

function notifyFriendsAboutRoom(io: Server, userId: string, room: Room) {
  // TODO: Get friends list and notify them
  // For now, broadcast to all
  io.emit('friend:roomCreated', {
    userId,
    room
  });
}

function broadcastOnlineStatus(io: Server, userId: string) {
  io.emit('friend:statusChanged', {
    userId,
    online: userSockets.has(userId)
  });
}

async function getOnlineFriends(userId: string): Promise<any[]> {
  // TODO: Implement actual friends query
  return [];
}

function getDefaultKeyConfig() {
  return {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    a: 'KeyX',
    b: 'KeyZ',
    x: 'KeyS',
    y: 'KeyA',
    l: 'KeyQ',
    r: 'KeyW',
    start: 'Enter',
    select: 'ShiftRight'
  };
}
