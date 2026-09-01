import http from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import session from 'express-session';
import passport from 'passport';
import express from 'express';
import { createClient } from 'redis';
import RedisStore from 'connect-redis';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';

const CASE = process.argv[2];
const REDIS = process.env.REDIS_URL || 'redis://localhost:6399';

const app = express();
if (CASE === 'full-app') {
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
  app.use(compression());
}
app.get('/health', (_, res) => res.send('ok'));

let store;
if (CASE === 'redis-store' || CASE === 'full-app') {
  const rc = createClient({ url: REDIS });
  await rc.connect();
  store = new RedisStore({ client: rc });
}

const httpServer = http.createServer(app);
const ioServer = new Server(httpServer, {
  cors: { origin: 'http://localhost:5173', credentials: true },
  transports: ['websocket'], perMessageDeflate: false, httpCompression: false
});

const sess = session({ store, secret: 'x'.repeat(40), resave: false, saveUninitialized: false });
passport.serializeUser((u, d) => d(null, u.id));
passport.deserializeUser((id, d) => setTimeout(() => d(null, { id }), 3));
ioServer.engine.use(sess);
ioServer.engine.use(passport.initialize());
ioServer.engine.use(passport.session());

await new Promise(r => httpServer.listen(0, r));
const port = httpServer.address().port;
const client = connect(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false, timeout: 4000 });
const verdict = await new Promise(resolve => {
  client.on('connect', () => resolve('CONNECTÉ'));
  client.on('connect_error', e => resolve('ÉCHEC: ' + e.message));
  setTimeout(() => resolve('DÉLAI DÉPASSÉ'), 5000);
});
console.log(`cas=${String(CASE).padEnd(13)} ${verdict}`);
process.exit(0);
