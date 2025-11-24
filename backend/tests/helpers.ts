import express, { Express } from 'express';
import session from 'express-session';
import passport from 'passport';
import { createServer, Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createClient } from 'redis';
import RedisStore from 'connect-redis';
import cors from 'cors';
import request from 'supertest';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { prisma } from '../src/db/prisma.js';
import { initializeAuth } from '../src/auth/passport.js';
import { authRouter } from '../src/api/auth.js';
import { gamesRouter } from '../src/api/games.js';
import { friendsRouter } from '../src/api/friends.js';
import { roomsRouter } from '../src/api/rooms.js';
import { userRouter } from '../src/api/user.js';
import { avatarsRouter } from '../src/api/avatars.js';
import { initializeWebSocket } from '../src/websocket/index.js';

export interface TestServer {
  app: Express;
  httpServer: HttpServer;
  io: SocketIOServer;
  redisClient: any; // Use any to avoid Redis type conflicts
  port: number;
  url: string;
}

export interface TestUser {
  id: string;
  email: string;
  displayName: string;
  googleId: string;
}

/**
 * Create a test server instance
 */
export async function createTestServer(): Promise<TestServer> {
  const app = express();
  const httpServer = createServer(app);
  const port = 3001;
  const url = `http://localhost:${port}`;

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*',
      credentials: true,
    },
    transports: ['websocket'],
  });

  // Redis client for tests
  const redisClient = createClient({
    socket: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6380'),
    },
  });

  await redisClient.connect();

  // Middleware
  app.use(cors({ origin: '*', credentials: true }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Session
  const sessionMiddleware = session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET || 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false,
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24,
      sameSite: 'lax',
    },
  });

  app.use(sessionMiddleware);

  // Passport
  app.use(passport.initialize());
  app.use(passport.session());
  initializeAuth();

  // Routes
  app.use('/auth', authRouter);
  app.use('/api/games', gamesRouter);
  app.use('/api/friends', friendsRouter);
  app.use('/api/rooms', roomsRouter);
  app.use('/api/user', userRouter);
  app.use('/api/avatars', avatarsRouter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // WebSocket
  io.engine.use(sessionMiddleware);
  io.engine.use(passport.initialize());
  io.engine.use(passport.session());
  initializeWebSocket(io);

  // Start server
  await new Promise<void>((resolve) => {
    httpServer.listen(port, resolve);
  });

  return { app, httpServer, io, redisClient, port, url };
}

/**
 * Close test server and clean up resources
 */
export async function closeTestServer(server: TestServer): Promise<void> {
  // Close Socket.IO
  await new Promise<void>((resolve, reject) => {
    server.io.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Close HTTP server
  await new Promise<void>((resolve, reject) => {
    server.httpServer.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Close Redis connection
  await server.redisClient.quit();

  // Disconnect Prisma
  await prisma.$disconnect();
}

/**
 * Create a test user in the database
 */
export async function createTestUser(data: {
  email: string;
  displayName: string;
  googleId: string;
}): Promise<TestUser> {
  const user = await prisma.user.create({
    data: {
      email: data.email,
      displayName: data.displayName,
      googleId: data.googleId,
    },
  });

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    googleId: user.googleId,
  };
}

/**
 * Create an authenticated HTTP agent using dev login
 * Returns a supertest agent with active session
 */
export async function createAuthenticatedAgent(
  server: TestServer
): Promise<any> {
  const agent = request.agent(server.app);

  // Login using dev mode
  await agent
    .post('/auth/dev/login')
    .send({ userId: '1' })
    .expect(200);

  return agent;
}

/**
 * Create an authenticated session for a user (deprecated - use createAuthenticatedAgent)
 * This creates the user in dev mode and returns agent
 */
export async function createAuthenticatedSession(
  server: TestServer,
  user: TestUser
): Promise<any> {
  // Just return an authenticated agent
  return createAuthenticatedAgent(server);
}

/**
 * Create an authenticated WebSocket client
 * @param userId - Dev user ID ('1' or '2'). Defaults to '1' if not provided
 */
export async function createAuthenticatedSocketClient(
  server: TestServer,
  user?: TestUser,
  userId: string = '1'
): Promise<ClientSocket> {
  console.log(`[createAuthenticatedSocketClient] Creating client for userId: ${userId}`);

  // Create an authenticated agent and extract cookies
  const agent = request.agent(server.app);
  const loginResponse = await agent
    .post('/auth/dev/login')
    .send({ userId })
    .expect(200);

  console.log(`[createAuthenticatedSocketClient] Login successful for userId: ${userId}`);

  // Extract the session cookie from the agent
  const setCookieHeader = loginResponse.headers['set-cookie'];
  const cookies = (typeof setCookieHeader === 'string'
    ? [setCookieHeader]
    : setCookieHeader) as string[] | undefined;
  const sessionCookie = cookies?.find((cookie: string) =>
    cookie.startsWith('connect.sid=')
  );

  if (!sessionCookie) {
    throw new Error('No session cookie found after authentication');
  }

  // Extract just the cookie value (before the semicolon)
  const cookieValue = sessionCookie.split(';')[0];

  console.log(`[createAuthenticatedSocketClient] Connecting WebSocket for userId: ${userId}`);

  const client = ioClient(server.url, {
    transports: ['websocket'],
    extraHeaders: {
      cookie: cookieValue,
    },
  });

  await new Promise<void>((resolve, reject) => {
    client.on('connect', () => {
      console.log(`[createAuthenticatedSocketClient] WebSocket connected for userId: ${userId}`);
      resolve();
    });
    client.on('connect_error', (err) => {
      console.error(`[createAuthenticatedSocketClient] WebSocket connection error for userId: ${userId}:`, err);
      reject(err);
    });
    setTimeout(() => {
      console.error(`[createAuthenticatedSocketClient] WebSocket connection timeout for userId: ${userId}`);
      reject(new Error('Connection timeout'));
    }, 5000);
  });

  return client;
}

/**
 * Disconnect a socket client and wait for it to fully disconnect
 */
export async function disconnectSocketClient(client: ClientSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    client.on('disconnect', () => {
      resolve();
    });
    client.disconnect();
    // Fallback timeout in case disconnect event never fires
    setTimeout(() => {
      resolve();
    }, 1000);
  });
}

/**
 * Wait for a specific event on a socket
 */
export function waitForSocketEvent<T = any>(
  socket: ClientSocket,
  eventName: string,
  timeoutMs = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timeout waiting for event: ${eventName}`));
    }, timeoutMs);

    const handler = (data: T) => {
      clearTimeout(timeout);
      resolve(data);
    };

    socket.once(eventName, handler);
  });
}

/**
 * Clean up database before/after tests
 */
export async function cleanupDatabase(): Promise<void> {
  // Delete in order to respect foreign key constraints
  await prisma.friendship.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * Clean up Redis sessions
 */
export async function cleanupRedis(server: TestServer): Promise<void> {
  // Clear all Redis keys
  await server.redisClient.flushDb();
}

/**
 * Disconnect all Socket.IO clients
 */
export async function disconnectAllSockets(server: TestServer): Promise<void> {
  // Get all connected sockets and disconnect them
  const sockets = await server.io.fetchSockets();

  console.log(`[disconnectAllSockets] Disconnecting ${sockets.length} sockets`);

  for (const socket of sockets) {
    socket.disconnect(true);
  }

  // Wait for disconnections to complete and cleanup to happen
  // Socket.IO disconnect handlers run asynchronously, we need to wait for them
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Verify all sockets are truly disconnected
  const remainingSockets = await server.io.fetchSockets();
  if (remainingSockets.length > 0) {
    console.warn(`[disconnectAllSockets] Warning: ${remainingSockets.length} sockets still connected after cleanup, forcing disconnect again`);
    // Try one more time
    for (const socket of remainingSockets) {
      socket.disconnect(true);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } else {
    console.log(`[disconnectAllSockets] All sockets successfully disconnected`);
  }
}

/**
 * Create a friendship between two users
 * Ensures users exist in database first (for dev users)
 */
export async function createFriendship(
  userId1: string,
  userId2: string
): Promise<void> {
  // Ensure both users exist in the database
  const devUsers = [
    {
      id: 'dev-user-1',
      email: 'user1@dev.local',
      displayName: 'Dev User 1',
      googleId: 'dev-google-id-1',
      avatar: '👤',
    },
    {
      id: 'dev-user-2',
      email: 'user2@dev.local',
      displayName: 'Dev User 2',
      googleId: 'dev-google-id-2',
      avatar: '👤',
    },
  ];

  for (const devUser of devUsers) {
    await prisma.user.upsert({
      where: { id: devUser.id },
      create: devUser,
      update: {},
    });
  }

  await prisma.friendship.create({
    data: {
      initiatorId: userId1,
      receiverId: userId2,
      status: 'accepted',
    },
  });
}
