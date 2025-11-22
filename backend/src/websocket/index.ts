import { Server, Socket } from 'socket.io';
import { Room, RoomPlayer, User, GameInput, KeyConfig } from '../types/index.js';
import { randomUUID } from 'crypto';
import { prisma } from '../db/prisma.js';
import { cache } from '../utils/cache.js';

const rooms = new Map<string, Room>();
const userSockets = new Map<string, string>(); // userId -> socketId
const socketUsers = new Map<string, User>(); // socketId -> User

// Export io instance for use in other modules
let ioInstance: Server | null = null;

export function getIO(): Server | null {
  return ioInstance;
}

export function getUserSocket(userId: string): string | undefined {
  return userSockets.get(userId);
}

export function getRooms(): Map<string, Room> {
  return rooms;
}

export function initializeWebSocket(io: Server) {
  ioInstance = io;

  io.on('connection', async (socket: Socket) => {
    console.log('Client connected:', socket.id);

    const userId = (socket.request as any).session?.passport?.user;
    if (!userId) {
      socket.disconnect();
      return;
    }

    // Load full user data from database (WebSocket doesn't run deserializeUser)
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      console.error('User not found:', userId);
      socket.disconnect();
      return;
    }

    console.log('User connected:', user.displayName, user.email);

    socketUsers.set(socket.id, user);
    userSockets.set(user.id, socket.id);

    // Send current rooms list
    socket.emit('rooms:list', Array.from(rooms.values()));

    // Notify friends that this user is now online
    await notifyFriendsStatusChanged(io, user.id, true);

    // Handle request for online friends status (client can request when ready)
    socket.on('friends:getOnlineStatus', async () => {
      const onlineFriends = await getOnlineFriends(user.id);
      socket.emit('friends:online', onlineFriends);
    });

    // Create room
    socket.on('room:create', async (data: { gameId: string; gameTitle: string; autoStart?: boolean }) => {
      const roomId = randomUUID();
      const userKeyConfig = await getUserKeyConfig(user.id);

      // If autoStart is true, host becomes player 1 immediately and game starts
      const autoStart = data.autoStart ?? false;

      const room: Room = {
        id: roomId,
        gameId: data.gameId,
        gameTitle: data.gameTitle,
        hostId: user.id,
        players: [{
          userId: user.id,
          displayName: user.displayName,
          avatar: user.avatar ?? undefined,
          port: autoStart ? 1 : null, // Auto-assign port 1 if autoStart
          isReady: autoStart, // Auto-ready if autoStart
          keyConfig: userKeyConfig
        }],
        status: autoStart ? 'playing' : 'waiting', // Start playing immediately if autoStart
        createdAt: new Date()
      };

      rooms.set(roomId, room);
      socket.join(roomId);

      socket.emit('room:created', room);
      broadcastRoomUpdate(io, room);
      notifyFriendsAboutRoom(io, user.id, room);

      // If autoStart, notify clients to start the game immediately
      if (autoStart) {
        // Notify friends that the game started
        await notifyFriendsRoomStatusChanged(io, user.id, room.id, 'playing');

        // Start game for host
        io.to(roomId).emit('game:started');
        console.log(`✅ Game auto-started for room ${roomId} (host: ${user.displayName})`);
      }
    });

    // Join room
    socket.on('room:join', async (data: { roomId: string }) => {
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

        // If game is already playing, notify this socket to start
        if (room.status === 'playing') {
          socket.emit('game:started');
        }
        return;
      }

      if (room.players.length >= 2) {
        socket.emit('error', { message: 'Room is full' });
        return;
      }

      // Allow joining even if game is in progress - guest becomes player 2 automatically
      const userKeyConfig = await getUserKeyConfig(user.id);

      // Auto-assign port 2 if game is already playing
      const autoAssignPort = room.status === 'playing' ? 2 : null;

      const player: RoomPlayer = {
        userId: user.id,
        displayName: user.displayName,
        avatar: user.avatar ?? undefined,
        port: autoAssignPort, // Auto-assign port 2 if game is playing
        isReady: autoAssignPort !== null, // Auto-ready if port is assigned
        keyConfig: userKeyConfig
      };

      room.players.push(player);
      socket.join(data.roomId);

      io.to(data.roomId).emit('room:updated', room);
      broadcastRoomUpdate(io, room);

      // If game is already playing, notify the new guest to start
      if (room.status === 'playing') {
        socket.emit('game:started');
        console.log(`✅ Guest ${user.displayName} joined room ${room.id} as Player 2 (game in progress)`);
      }
    });

    // Leave room
    socket.on('room:leave', (data: { roomId: string }) => {
      handleLeaveRoom(io, socket, data.roomId);
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
      // Auto-ready when selecting a port
      player.isReady = true;
      io.to(data.roomId).emit('room:updated', room);
    });

    // Unselect controller port
    socket.on('room:unselectPort', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      const player = room.players.find(p => p.userId === user.id);
      if (!player) return;

      player.port = null;
      // Player is no longer ready when unselecting
      player.isReady = false;
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

    // Start game (client-side emulation)
    socket.on('game:start', async (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      // Check if at least one player has selected a port (auto-ready)
      const playersWithPorts = room.players.filter(p => p.port !== null && p.isReady);
      if (playersWithPorts.length === 0) {
        socket.emit('error', { message: 'At least one player must select a controller port' });
        return;
      }

      room.status = 'playing';
      io.to(data.roomId).emit('room:updated', room);

      // Notify friends that the game started
      await notifyFriendsRoomStatusChanged(io, room.hostId, room.id, 'playing');

      // Client-side emulation: Just notify clients to start their emulators
      // No server-side emulator needed - P1 (host) runs emulator and streams via WebRTC
      io.to(room.id).emit('game:started');
      console.log(`✅ Game started for room ${room.id} (client-side emulation)`);
    });

    // Game input - NO LONGER NEEDED (client-side emulation)
    // Input is handled locally on host client or sent via P2P from guests
    socket.on('game:input', (_data: { roomId: string; input: GameInput & { timestamp?: number } }) => {
      // No-op for client-side emulation
      // Kept for backwards compatibility but does nothing
    });

    // Pause game (client-side emulation)
    socket.on('game:pause', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      // Client-side emulation: Pause is handled on host client
      room.status = 'paused';
      io.to(data.roomId).emit('game:paused');
    });

    // Resume game (client-side emulation)
    socket.on('game:resume', (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      // Client-side emulation: Resume is handled on host client
      room.status = 'playing';
      io.to(data.roomId).emit('game:resumed');
    });

    // Stop game (client-side emulation)
    socket.on('game:stop', async (data: { roomId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      // Client-side emulation: No server-side emulator to stop
      room.status = 'waiting';
      // Reset ready status but keep port selections
      room.players.forEach(p => {
        if (p.port !== null) {
          p.isReady = true; // Players with ports remain ready
        } else {
          p.isReady = false;
        }
      });
      io.to(data.roomId).emit('game:stopped');
      io.to(data.roomId).emit('room:updated', room);
      console.log(`🛑 Game stopped for room ${room.id} (client-side emulation)`);
    });

    // Save state (client-side emulation)
    // TODO: Implement client-side save state management
    socket.on('game:save', async (data: { roomId: string; slotNumber: number; name: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      // Client-side emulation: Save state is handled on host client
      // For now, just acknowledge - implement server-side save storage later if needed
      socket.emit('game:saved', { slotNumber: data.slotNumber });
    });

    // Load state (client-side emulation)
    // TODO: Implement client-side save state management
    socket.on('game:load', async (data: { roomId: string; saveId: string }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      // Client-side emulation: Load state is handled on host client
      // For now, just acknowledge - implement server-side save retrieval later if needed
      io.to(data.roomId).emit('game:loaded', { saveId: data.saveId });
    });

    // Set emulation speed (client-side emulation)
    socket.on('game:setSpeed', (data: { roomId: string; speed: number }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      // Client-side emulation: Speed is handled on host client
      // Just broadcast to all clients in room
      io.to(data.roomId).emit('game:speedChanged', { speed: data.speed });
    });

    // Set target FPS (client-side emulation)
    socket.on('game:setTargetFPS', (data: { roomId: string; targetFPS: number }) => {
      const room = rooms.get(data.roomId);
      if (!room) return;

      // Client-side emulation: FPS is handled on host client
      // Just broadcast to all clients in room
      io.to(data.roomId).emit('game:targetFPSChanged', { targetFPS: data.targetFPS });
    });

    // Simple P2P room join (for P2P POC/testing - no game state)
    socket.on('p2p:join', (data: { roomId: string }) => {
      console.log(`🔗 ${user.displayName} joining P2P room: ${data.roomId}`);
      socket.join(data.roomId);

      // Notify others in the room
      socket.to(data.roomId).emit('p2p:peer-joined', {
        socketId: socket.id,
        userId: user.id,
        displayName: user.displayName
      });

      // Send confirmation to the joiner
      socket.emit('p2p:joined', { roomId: data.roomId });
    });

    // WebRTC Signaling (for P2P emulation)
    socket.on('webrtc:signal', (data: { roomId: string; signal: any }) => {
      console.log(`📡 Relaying WebRTC signal in room ${data.roomId} from ${socket.id}`);

      // Forward WebRTC signal to other players in the room (except sender)
      socket.to(data.roomId).emit('webrtc:signal', {
        signal: data.signal,
        from: socket.id
      });
    });

    // Disconnect
    socket.on('disconnect', async () => {
      console.log('Client disconnected:', socket.id);

      // Notify friends that this user is now offline (BEFORE cleanup)
      await notifyFriendsStatusChanged(io, user.id, false);

      // Find and leave all rooms
      rooms.forEach((room, roomId) => {
        if (room.players.some(p => p.userId === user.id)) {
          handleLeaveRoom(io, socket, roomId);
        }
      });

      // Clean up user mappings
      socketUsers.delete(socket.id);
      userSockets.delete(user.id);
    });
  });

  return { rooms };
}

async function handleLeaveRoom(
  io: Server,
  socket: Socket,
  roomId: string
) {
  const room = rooms.get(roomId);
  if (!room) return;

  const user = socketUsers.get(socket.id);
  if (!user) return;

  const wasHost = room.hostId === user.id;

  room.players = room.players.filter(p => p.userId !== user.id);
  socket.leave(roomId);

  if (room.players.length === 0) {
    // Room is empty, destroy it (client-side emulation - no cleanup needed)
    // Notify friends before deleting the room
    await notifyFriendsRoomStatusChanged(io, room.hostId, room.id, 'destroyed');

    rooms.delete(roomId);
    io.emit('room:destroyed', { roomId });
  } else {
    // Notify remaining players about who left
    console.log(`📢 Emitting player:left to room ${roomId}:`, {
      userId: user.id,
      displayName: user.displayName,
      wasHost
    });
    io.to(roomId).emit('player:left', {
      userId: user.id,
      displayName: user.displayName,
      wasHost
    });

    // If host left, assign new host and notify everyone to redirect
    if (wasHost) {
      room.hostId = room.players[0].userId;
      // When host leaves, everyone should be redirected
      io.to(roomId).emit('host:left');
    }

    io.to(roomId).emit('room:updated', room);
    broadcastRoomUpdate(io, room);
  }
}

function broadcastRoomUpdate(io: Server, room: Room) {
  io.emit('room:update', room);
}

async function notifyFriendsAboutRoom(io: Server, userId: string, room: Room) {
  // Get user's friends (with caching - 30 seconds TTL)
  const cacheKey = `friendships:${userId}`;
  let friendships = cache.get<any[]>(cacheKey);

  if (!friendships) {
    friendships = await prisma.friendship.findMany({
      where: {
        OR: [
          { initiatorId: userId },
          { receiverId: userId }
        ],
        status: 'accepted'
      }
    });
    cache.set(cacheKey, friendships, 30000); // Cache for 30 seconds
  }

  // Notify each online friend
  friendships.forEach(friendship => {
    const friendId = friendship.initiatorId === userId ? friendship.receiverId : friendship.initiatorId;
    const friendSocketId = getUserSocket(friendId);

    if (friendSocketId) {
      io.to(friendSocketId).emit('friend:roomCreated', {
        userId,
        room
      });
    }
  });
}

async function notifyFriendsRoomStatusChanged(io: Server, userId: string, roomId: string, status: 'playing' | 'destroyed') {
  // Get user's friends (with caching - 30 seconds TTL)
  const cacheKey = `friendships:${userId}`;
  let friendships = cache.get<any[]>(cacheKey);

  if (!friendships) {
    friendships = await prisma.friendship.findMany({
      where: {
        OR: [
          { initiatorId: userId },
          { receiverId: userId }
        ],
        status: 'accepted'
      }
    });
    cache.set(cacheKey, friendships, 30000); // Cache for 30 seconds
  }

  // Notify each online friend
  friendships.forEach(friendship => {
    const friendId = friendship.initiatorId === userId ? friendship.receiverId : friendship.initiatorId;
    const friendSocketId = getUserSocket(friendId);

    if (friendSocketId) {
      io.to(friendSocketId).emit('friend:roomStatusChanged', {
        userId,
        roomId,
        status
      });
    }
  });
}

async function notifyFriendsStatusChanged(io: Server, userId: string, online: boolean) {
  // Get user's friends (with caching - 30 seconds TTL)
  const cacheKey = `friendships:${userId}`;
  let friendships = cache.get<any[]>(cacheKey);

  if (!friendships) {
    friendships = await prisma.friendship.findMany({
      where: {
        OR: [
          { initiatorId: userId },
          { receiverId: userId }
        ],
        status: 'accepted'
      }
    });
    cache.set(cacheKey, friendships, 30000); // Cache for 30 seconds
  }

  // Notify each online friend about status change
  friendships.forEach(friendship => {
    const friendId = friendship.initiatorId === userId ? friendship.receiverId : friendship.initiatorId;
    const friendSocketId = getUserSocket(friendId);

    if (friendSocketId) {
      io.to(friendSocketId).emit('friend:statusChanged', {
        userId,
        online
      });
    }
  });
}

async function getOnlineFriends(userId: string): Promise<any[]> {
  // Get user's accepted friendships
  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { initiatorId: userId },
        { receiverId: userId }
      ],
      status: 'accepted'
    },
    include: {
      initiator: {
        select: {
          id: true,
          displayName: true,
          avatar: true,
          email: true
        }
      },
      receiver: {
        select: {
          id: true,
          displayName: true,
          avatar: true,
          email: true
        }
      }
    }
  });

  // Map to friend user objects with online status
  return friendships.map(friendship => {
    const friend = friendship.initiatorId === userId ? friendship.receiver : friendship.initiator;
    return {
      ...friend,
      online: userSockets.has(friend.id)
    };
  });
}

function getDefaultKeyConfig(): KeyConfig {
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

async function getUserKeyConfig(userId: string): Promise<KeyConfig> {
  // Cache user key configs for 5 minutes (they don't change often)
  const cacheKey = `keyconfig:${userId}`;
  let config = cache.get<KeyConfig>(cacheKey);

  if (config) {
    return config;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { controlsConfig: true }
    });

    if (user?.controlsConfig) {
      const parsedConfig = JSON.parse(user.controlsConfig);
      cache.set(cacheKey, parsedConfig, 300000); // Cache for 5 minutes
      return parsedConfig;
    }
  } catch (error) {
    console.error('Error loading user controls config:', error);
  }

  const defaultConfig = getDefaultKeyConfig();
  cache.set(cacheKey, defaultConfig, 300000);
  return defaultConfig;
}
