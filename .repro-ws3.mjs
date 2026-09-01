import http from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import session from 'express-session';
import passport from 'passport';
import express from 'express';

const CASE = process.argv[2];

const app = express();
app.get('/health', (_, res) => res.send('ok'));
const httpServer = http.createServer(app);

const base = { cors: { origin: 'http://localhost:5173', credentials: true } };
const appOpts = {
  ...base,
  transports: ['websocket'],
  pingTimeout: 60000, pingInterval: 25000, upgradeTimeout: 10000,
  maxHttpBufferSize: 1e8, perMessageDeflate: false, httpCompression: false
};

const opts = CASE === 'app-options' ? appOpts
  : CASE === 'ws-only' ? { ...base, transports: ['websocket'] }
  : CASE === 'no-deflate' ? { ...base, perMessageDeflate: false }
  : base;

const ioServer = new Server(httpServer, opts);
const sess = session({ secret: 'x'.repeat(40), resave: false, saveUninitialized: false });
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
