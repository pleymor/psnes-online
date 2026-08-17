import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { createServer } from 'http';
import { Server } from 'socket.io';
import RedisStore from 'connect-redis';
import { createClient } from 'redis';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';

import { initializeAuth } from './auth/passport.js';
import { authRouter } from './api/auth.js';
import { gamesRouter } from './api/games.js';
import { friendsRouter } from './api/friends.js';
import { roomsRouter } from './api/rooms.js';
import { userRouter } from './api/user.js';
import { avatarsRouter } from './api/avatars.js';
import { logsRouter } from './api/logs.js';
import { initializeWebSocket } from './websocket/index.js';
import { refreshGameMetadata } from './services/metadata-loader.js';
import { ensureAvatarsDir } from './utils/avatar.js';
import { requestLogger } from './middleware/logger.js';
import { errorHandler } from './middleware/error.js';
import { logger } from './utils/logger.js';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';

// Fail fast rather than silently falling back to a well-known default: a
// guessable SESSION_SECRET makes every session cookie forgeable. Placeholder
// values are rejected too, since the shipped .env.example values would
// otherwise satisfy a mere presence check.
if (isProduction) {
  const REQUIRED_SECRETS = ['SESSION_SECRET', 'TOKEN_ENCRYPTION_KEY'];
  const PLACEHOLDER_PATTERN = /change|your-|example|secret-key|generate-with/i;

  const unusable = REQUIRED_SECRETS.filter(key => {
    const value = process.env[key];
    return !value || value.length < 32 || PLACEHOLDER_PATTERN.test(value);
  });

  if (unusable.length > 0) {
    logger.fatal(
      { unusable },
      'Refusing to start in production: required secrets are missing, too short (<32 chars), or still set to a placeholder'
    );
    process.exit(1);
  }

  if (process.env.AUTH_MODE === 'dev') {
    logger.fatal('AUTH_MODE=dev is not permitted in production');
    process.exit(1);
  }
}

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

const app = express();

// Trust nginx proxy for secure cookies (only when behind a reverse proxy)
if (process.env.BEHIND_PROXY === 'true') {
  app.set('trust proxy', 1);
}

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

// Redis client
const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
  }
});

redisClient.on('error', (err) => logger.error({ err }, 'Redis error'));
await redisClient.connect();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Disable for development
}));

// Enable gzip compression for all responses
app.use(compression({
  level: 6, // Balanced compression level (0-9)
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(requestLogger);

// Session
const sessionMiddleware = session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.BEHIND_PROXY === 'true', // Only secure when behind HTTPS proxy
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    sameSite: 'lax',
    path: '/',
    domain: process.env.COOKIE_DOMAIN || undefined // undefined = auto-detect
  }
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
app.use('/api/logs', logsRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Terminal error handler: must come after all routes.
app.use(errorHandler);

// WebSocket - Share session with Socket.IO
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

initializeWebSocket(io);

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, async () => {
  logger.info(`🚀 Server running on http://localhost:${PORT}`);
  logger.info('🎮 WebSocket ready for connections');

  // Ensure avatars directory exists
  await ensureAvatarsDir();
  logger.info('📁 Avatars directory ready');

  // Refresh game metadata at startup (reload from JSON file)
  try {
    await refreshGameMetadata();
  } catch (error) {
    logger.warn('⚠️  Failed to refresh game metadata, but server is still running');
  }
});
