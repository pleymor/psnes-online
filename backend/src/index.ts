import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { createServer } from 'http';
import { Server } from 'socket.io';
import RedisStore from 'connect-redis';
import { createClient } from 'redis';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

import { initializeAuth } from './auth/passport.js';
import { authRouter } from './api/auth.js';
import { gamesRouter } from './api/games.js';
import { friendsRouter } from './api/friends.js';
import { roomsRouter } from './api/rooms.js';
import { userRouter } from './api/user.js';
import { initializeWebSocket } from './websocket/index.js';
import { loadGameMetadata } from './services/metadata-loader.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true
  }
});

// Redis client
const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379')
  }
});

redisClient.on('error', (err) => console.error('Redis error:', err));
await redisClient.connect();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // Disable for development
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routing logger middleware
app.use((req, res, next) => {
  const start = Date.now();
  const originalSend = res.send;

  res.send = function (data) {
    const duration = Date.now() - start;
    const user = (req as any).user;

    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} - ${duration}ms` +
      (user ? ` - User: ${user.id || user.email}` : ' - Guest') +
      (Object.keys(req.query).length > 0 ? ` - Query: ${JSON.stringify(req.query)}` : ''));

    return originalSend.call(this, data);
  };

  next();
});

// Session
const sessionMiddleware = session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    sameSite: 'lax',
    path: '/',
    domain: 'localhost'
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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// WebSocket - Share session with Socket.IO
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

initializeWebSocket(io);

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🎮 WebSocket ready for connections`);

  // Load game metadata at startup
  try {
    await loadGameMetadata();
  } catch (error) {
    console.error('⚠️  Failed to load game metadata, but server is still running');
  }
});
