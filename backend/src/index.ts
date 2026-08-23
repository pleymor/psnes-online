import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { createServer } from 'http';
import { Server } from 'socket.io';
import RedisStore from 'connect-redis';
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
import { metadataRouter } from './api/metadata.js';
import { coversRouter } from './api/covers.js';
import { logsRouter } from './api/logs.js';
import { initializeWebSocket, getRooms, getUserSocket } from './websocket/index.js';
import { flushRooms, restoreRooms, startRoomSnapshots } from './websocket/room-snapshot.js';
import { markOffline } from './rooms/presence.js';
import { connectRedis } from './db/redis.js';
import { getDb } from './db/sqlite.js';
import { deleteExpiredInvitations, deleteInvitationsForRoom } from './db/invitations.js';
import { abandonedRoomIds } from './rooms/abandonment.js';
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
  const REQUIRED_SECRETS = ['SESSION_SECRET'];
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

const redisClient = await connectRedis();

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
/**
 * Refuses to start in production with a secret missing.
 *
 * Every one of these had a silent fallback or a non-null assertion, which is
 * the wrong shape for a secret: the server starts, looks healthy, and fails
 * somewhere confusing later. SESSION_SECRET was the worst of them - it fell
 * back to a value written in this repository, so a missing variable would have
 * signed every session with a secret anyone can read, and the only visible
 * symptom would have been players having to sign in again unexpectedly. That
 * is indistinguishable from an ordinary session expiry, which is exactly why
 * it needed to be loud.
 *
 * Crashing on boot costs a failed deploy, which is noisy, immediate and
 * touches no data. Starting up wrong costs trust.
 */
function requireSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return;

  // SESSION_SECRET is deliberately not listed here: the check above, which
  // runs before this function is even called, already rejects a missing,
  // too-short (<32 chars) or placeholder SESSION_SECRET in production and
  // exits the process. Re-adding it here would just be a check that can
  // never fire.
  const required: string[] = [];
  // Only when Google is the auth mode: the alternative mode needs none of them,
  // and demanding them would break it.
  if ((process.env.AUTH_MODE || 'google') === 'google') {
    required.push('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL');
  }

  const missing = required.filter(name => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Refusing to start in production without: ${missing.join(', ')}. ` +
        'These have no safe default - a fallback secret would be public, and ' +
        'absent Google credentials would let the server run while nobody can ' +
        'sign in.'
    );
  }
}

requireSecrets();

const sessionMiddleware = session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  resave: false,
  saveUninitialized: false,
  /**
   * Slide the window on every response.
   *
   * Without this the expiry is fixed at login and never moves, however much
   * the app is used - so a session simply lapses seven days later, and it
   * lapsed once in the middle of a game. The socket does not notice, because
   * it reads the user id at handshake and holds it, so the app carries on
   * looking alive while every HTTP request answers 401.
   *
   * Note this only slides on HTTP traffic: `io.engine.use(sessionMiddleware)`
   * below runs at the handshake, not on socket messages, so hours of play
   * refresh nothing. Loading the page is enough to push the window out by a
   * week, which makes expiry-during-play a very narrow case rather than an
   * impossible one - the client still has to handle a 401 rather than assume
   * one cannot happen.
   */
  rolling: true,
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
app.use('/api/metadata', metadataRouter);
app.use('/api/covers', coversRouter);
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

const rooms = getRooms();

/*
 * Invitations whose deadline has passed, cleared once at boot.
 *
 * A room that dies cleanly takes its invitations with it, but a crash leaves
 * them behind with nothing to remove them. Nothing ever reads a stale row -
 * `lobby:accept` and the connection-time delivery both check that the room
 * still exists - so this is housekeeping and nothing more, which is exactly
 * why it is wrapped: a failure to tidy up must never be the reason the server
 * cannot start.
 */
try {
  const swept = deleteExpiredInvitations(getDb(), new Date());
  if (swept > 0) logger.info({ swept }, 'Cleared expired invitations');
} catch (err) {
  logger.warn({ err }, 'Could not sweep expired invitations; carrying on');
}

// Before the port opens, so the first client to reconnect finds its room
// already there rather than racing the restore.
const bootedAt = new Date();
await restoreRooms(rooms, room => {
  // A restart dropped everybody, through no action of theirs. An existing
  // `abandonedAt` is kept by markOffline: the deadline began when the room
  // emptied, and a deploy must not hand an abandoned room another twelve hours.
  for (const player of room.players) markOffline(room, player.userId, bootedAt);
});

/**
 * Destroys the rooms nobody came back to.
 *
 * Running this at restore is what makes the snapshot TTL a storage bound rather
 * than a lifetime: however long the key sat in Redis, what decides a room's
 * fate is how long it has been empty.
 */
function sweepAbandonedRooms(now: Date) {
  for (const roomId of abandonedRoomIds(rooms, now)) {
    rooms.delete(roomId);
    deleteInvitationsForRoom(getDb(), roomId);
    logger.info({ roomId }, 'Swept a room nobody came back to');
  }
}

sweepAbandonedRooms(bootedAt);

// Hourly: twelve hours is the deadline, so an hour of slack costs nothing and
// keeps this off the hot path. `unref` for the usual reason - a sweep must
// never be what holds the process open.
const abandonmentSweep = setInterval(() => sweepAbandonedRooms(new Date()), 60 * 60_000);
abandonmentSweep.unref();

startRoomSnapshots(rooms);

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

/**
 * A deployment is a graceful shutdown: Docker sends SIGTERM and waits ten
 * seconds. Flushing here is what makes the room snapshot exact for the case
 * that motivated it - the periodic write only covers a hard crash.
 */
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down; saving rooms');

  try {
    await flushRooms(rooms);
  } catch (err) {
    logger.error({ err }, 'Could not save rooms on the way out');
  }

  httpServer.close();
  try {
    await redisClient.quit();
  } catch {
    // Already gone; nothing to salvage and nothing to report.
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
