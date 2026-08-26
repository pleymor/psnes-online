import 'dotenv/config';
import { createServer } from 'http';
import { Server } from 'socket.io';
import passport from 'passport';

import { assertUsableEnvironment } from './bootstrap/env-guard.js';
import { buildApp } from './bootstrap/app.js';
import { restoreAndSweep, startBackgroundJobs, warmStartupCaches } from './bootstrap/jobs.js';
import { installShutdownHandlers } from './bootstrap/shutdown.js';
import { connectRedis } from './db/redis.js';
import { initializeWebSocket, getRooms } from './websocket/index.js';
import { logger } from './utils/logger.js';

const isProduction = process.env.NODE_ENV === 'production';
assertUsableEnvironment(isProduction);

// Last-resort safety nets. Route and socket handlers are wrapped so their
// rejections are handled locally; these only catch what slipped through, and
// exist so an isolated failure is logged instead of killing the server.
process.on('unhandledRejection', reason => {
  logger.error({ err: reason }, 'Unhandled promise rejection (server kept alive)');
});

process.on('uncaughtException', err => {
  // State is unknown after an uncaught throw, so exit and let the restart
  // policy take over rather than serving from a corrupted process.
  logger.fatal({ err }, 'Uncaught exception, shutting down');
  process.exit(1);
});

const redisClient = await connectRedis();
const { app, sessionMiddleware } = buildApp(redisClient);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true
  },
  // Optimize for low latency
  transports: ['websocket'], // Force WebSocket (no polling fallback for lower latency)
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 10000,
  maxHttpBufferSize: 1e8, // 100MB for large frames
  perMessageDeflate: false, // Disable compression for lower latency (CPU vs latency tradeoff)
  httpCompression: false
});

// WebSocket - Share session with Socket.IO
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

initializeWebSocket(io);

const rooms = getRooms();

// Before the port opens, so the first client to reconnect finds its room
// already there rather than racing the restore.
await restoreAndSweep(rooms);
startBackgroundJobs(rooms);

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, async () => {
  logger.info(`🚀 Server running on http://localhost:${PORT}`);
  logger.info('🎮 WebSocket ready for connections');

  await warmStartupCaches();
});

installShutdownHandlers({ httpServer, redisClient, rooms });
