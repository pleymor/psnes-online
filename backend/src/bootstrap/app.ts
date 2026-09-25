import express, { Express, RequestHandler } from 'express';
import session from 'express-session';
import passport from 'passport';
import RedisStore from 'connect-redis';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import type { RedisClientType } from 'redis';

import { initializeAuth } from '../auth/passport.js';
import { authRouter } from '../api/auth.js';
import { gamesRouter } from '../api/games.js';
import { savesRouter } from '../api/saves.js';
import { syncRouter } from '../api/sync.js';
import { friendsRouter } from '../api/friends.js';
import { ratingsRouter } from '../api/ratings.js';
import { roomsRouter } from '../api/rooms.js';
import { userRouter } from '../api/user.js';
import { invitesRouter } from '../api/invites.js';
import { avatarsRouter } from '../api/avatars.js';
import { metadataRouter } from '../api/metadata.js';
import { coversRouter } from '../api/covers.js';
import { COVERS_DIR } from '../covers/store.js';
import { logsRouter } from '../api/logs.js';
import { pseudoRouter } from '../api/pseudo.js';
import { requireAccount, requirePseudo } from '../middleware/auth.js';
import { requestLogger } from '../middleware/logger.js';
import { MAX_ARCHIVE_BYTES } from '../saves/archive.js';
import { errorHandler } from '../middleware/error.js';

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

  // SESSION_SECRET is deliberately not listed here: assertUsableEnvironment,
  // which runs before this function is even called, already rejects a
  // missing, too-short (<32 chars) or placeholder SESSION_SECRET in
  // production and exits the process. Re-adding it here would just be a
  // check that can never fire.
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

/**
 * Builds and wires the Express app: security/compression middleware, the
 * session, Passport, and every router. Returns the session middleware too,
 * since the caller shares it with Socket.IO's handshake via
 * `io.engine.use(sessionMiddleware)`.
 */
export function buildApp(redisClient: RedisClientType): { app: Express; sessionMiddleware: RequestHandler } {
  const app = express();

  // Trust nginx proxy for secure cookies (only when behind a reverse proxy)
  if (process.env.BEHIND_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

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

  /*
   * The save archive is the one body that is legitimately enormous: a
   * savestate is over 800KB and a library can hold a hundred games, each with
   * a PNG thumbnail per save. The default 100KB would reject every real
   * import with a 413 that says nothing useful.
   *
   * Mounted BEFORE the general parser and scoped to the one path, so the
   * ceiling is raised exactly where it has to be and nowhere else - body-parser
   * marks the request as read, which makes the general parser below a no-op
   * for it rather than a second, smaller limit.
   */
  app.use('/api/saves/import', express.json({ limit: MAX_ARCHIVE_BYTES }));
  // La file des sauvegardes (#71) porte un savestate par requête : 800KB, soit
  // plus d'un mégaoctet en base64, et la vignette avec. Même montage, même
  // raison ; `api/sync.ts` borne chaque champ décodé.
  app.use('/api/sync', express.json({ limit: '8mb' }));

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(requestLogger);

  requireSecrets();

  // Session
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
     * runs at the handshake, not on socket messages, so hours of play refresh
     * nothing. Loading the page is enough to push the window out by a week,
     * which makes expiry-during-play a very narrow case rather than an
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
  // The onboarding policy, in one readable block.
  //
  // requirePseudo is applied here rather than inside each router so that the
  // whole rule fits on one screen, and so that adding a router forces a decision
  // about it: you cannot mount a route without writing or omitting the guard
  // under the eyes of the eight others. Scattered through the routers, the rule
  // would be invisible at the moment somebody forgets it.
  //
  // Two are deliberately open: /api/pseudo is the way out of the gate, and
  // /api/avatars is what the blocking modal renders the player's own face with.
  //
  // Depuis qu'on peut jouer sans compte, requirePseudo a une troisième
  // branche : une session anonyme reçoit 403 sur tout ce bloc. Elle n'a ni
  // bibliothèque, ni amis, ni profil, ni journaux à envoyer - elle a un siège
  // dans un salon, et c'est le socket qui le lui donne.
  //
  // /api/pseudo est la seule exception qui a dû changer de garde : ouverte à
  // requirePseudo par construction (c'est la sortie du portique), elle aurait
  // laissé un anonyme réserver un handle définitif dans un espace de noms
  // unique au nom d'une session qui disparaît le soir même. requireAccount dit
  // exactement cela : il faut un compte, le pseudonyme n'y change rien.
  //
  // /api/avatars reste ouverte : un anonyme est assis dans un salon dont
  // l'autre joueur a un visage à afficher.
  app.use('/auth', authRouter);
  app.use('/api/pseudo', requireAccount, pseudoRouter);
  app.use('/api/avatars', avatarsRouter);
  app.use('/api/games', requirePseudo, gamesRouter);
  app.use('/api/saves', requirePseudo, savesRouter);
  app.use('/api/sync', requirePseudo, syncRouter);
  app.use('/api/friends', requirePseudo, friendsRouter);
  app.use('/api/ratings', requirePseudo, ratingsRouter);
  app.use('/api/rooms', requirePseudo, roomsRouter);
  app.use('/api/user', requirePseudo, userRouter);
  // `requirePseudo` et pas `requireAccount` : un anonyme n'invite personne, et
  // un compte qui n'a pas encore choisi son pseudonyme n'a rien à distribuer.
  app.use('/api/invites', requirePseudo, invitesRouter);
  app.use('/api/metadata', requirePseudo, metadataRouter);
  // Publique, comme /api/avatars et pour une raison plus forte encore : une
  // réponse authentifiée est une réponse qu'aucun cache n'a le droit de
  // garder, donc chaque jaquette repartait du VPS à chaque visite. Voir
  // api/covers.ts. Ce n'est plus le chemin habituel non plus : les lignes
  // ingérées pointent vers /covers/<empreinte>.webp.
  app.use('/api/covers', coversRouter);
  app.use('/api/logs', requirePseudo, logsRouter);

  /*
   * Les jaquettes ingérées.
   *
   * En production nginx sert ce chemin depuis le volume et cette ligne ne
   * voit jamais une requête (frontend/nginx.conf a sa propre `location
   * /covers/`, qui ne relaie rien). Elle existe pour le mode dev, où le
   * frontend est Vite et où il n'y a pas de nginx du tout - sans elle, une
   * jaquette ingérée serait introuvable sur la machine du développeur.
   *
   * Le nom d'un fichier est l'empreinte de ses octets sources, donc
   * `immutable` est vrai plutôt qu'espéré.
   */
  app.use(
    '/covers',
    express.static(COVERS_DIR, {
      immutable: true,
      maxAge: '1y'
    })
  );

  /*
   * Une jaquette pas encore ingérée est un cas ordinaire, pas une panne.
   *
   * Mesuré en lançant le serveur : avec `fallthrough: false`, express.static
   * fait remonter le fichier manquant au gestionnaire d'erreurs terminal, qui
   * répond 500. Un catalogue dont la passe de chauffe n'est pas finie aurait
   * rempli le journal d'erreurs serveur pour des images simplement absentes,
   * et `<img on:error>` retombe déjà sur l'étiquette de cartouche.
   */
  app.use('/covers', (_req, res) => {
    res.status(404).json({ error: 'Cover not found' });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Terminal error handler: must come after all routes.
  app.use(errorHandler);

  return { app, sessionMiddleware };
}
