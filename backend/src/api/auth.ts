import { Router } from 'express';
import passport from 'passport';
import { getAuthMode } from '../auth/passport.js';
import { getDb } from '../db/sqlite.js';
import { createAnonymousUser, deleteAnonymousUser, PseudoFullError, upsertDevUser } from '../db/users.js';
import { getRooms } from '../websocket/index.js';
import { anonymousDoorDecision, anonymousJoinEnabled } from '../auth/anonymous.js';
import { anonymousDoorLimit } from '../utils/attempt-limit.js';
import type { User } from '../db/types.js';
import { createLogger } from '../utils/logger.js';
import { asyncHandler } from '../middleware/async-handler.js';

const logger = createLogger('Auth');

export const authRouter = Router();

const AUTH_MODE = getAuthMode();

// Google OAuth routes (only available in google mode)
if (AUTH_MODE === 'google') {
  authRouter.get('/google', passport.authenticate('google', {
    // Identity only, and now not even that much. 'email' is gone with the
    // email column: a player is a pseudonym they chose, so there is nothing
    // Google could tell us about their address that we would be allowed to
    // keep. Not requesting it is stronger than requesting and discarding -
    // there is no longer anything to leak into a log by accident.
    scope: ['profile']
    // No accessType or prompt. Both were here to obtain a refresh token, which
    // Google only issues when consent is granted afresh - so `prompt: 'consent'`
    // forced its consent screen on EVERY sign-in, even with a live Google
    // session and consent already given. That is why signing in felt like
    // reconnecting rather than a redirect.
    //
    // They were left behind by the Drive integration. Nothing uses a Google
    // token any more: the strategy callback in auth/passport.ts is handed both
    // and reads neither, taking only the profile. So the cost was a screen
    // nobody needed for a token nobody wanted.
  }));

  authRouter.get('/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    (req, res) => {
      res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173');
    }
  );
}

// Dev mode authentication routes.
// `/dev/login` is an unauthenticated route that hands out a real session, so it
// must never be reachable in production even if AUTH_MODE is misconfigured.
if (AUTH_MODE === 'dev' && process.env.NODE_ENV !== 'production') {
  // Login as dev user
  authRouter.post('/dev/login', asyncHandler(async (req, res) => {
    try {
      const { userId } = req.body;

      if (!userId || !['1', '2', '3'].includes(userId)) {
        return res.status(400).json({ error: 'Invalid user ID. Must be 1, 2 or 3.' });
      }

      // Users 1 and 2 have chosen their pseudonyms; user 3 exists to sit
      // behind the onboarding gate.
      //
      // A third account rather than leaving user 2 unchosen, for two reasons
      // found while wiring the tests. Every two-player e2e test signs in as
      // user 2 and opens a socket, and the server now refuses a socket from an
      // account with no chosen pseudonym - so user 2 has to be past the gate.
      // And upsertDevUser only refreshes the avatar on conflict, so a
      // pseudonym claimed once would stick: the gate would be testable exactly
      // once per database. Hence the explicit reset below.
      const devUsers = [
        {
          id: 'dev-user-1',
          googleId: 'dev-google-id-1',
          pseudo: 'DevOne',
          discriminator: '0001',
          pseudoChosenAt: Date.now(),
          avatar: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=DevUser1&backgroundColor=667eea'
        },
        {
          id: 'dev-user-2',
          googleId: 'dev-google-id-2',
          pseudo: 'DevTwo',
          discriminator: '0002',
          pseudoChosenAt: Date.now(),
          avatar: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=DevUser2&backgroundColor=764ba2'
        },
        {
          id: 'dev-user-3',
          googleId: 'dev-google-id-3',
          pseudo: 'Newcomer',
          discriminator: '0003',
          pseudoChosenAt: null,
          avatar: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=DevUser3&backgroundColor=43a047'
        }
      ];

      const userData = devUsers[parseInt(userId) - 1];

      // Puts the account into exactly the state declared above, existing row
      // or not - so user 3 is back in front of the gate on every sign-in, and
      // users 1 and 2 are past it even on a database where migration 0004 has
      // just set everyone's pseudoChosenAt to NULL.
      const user = upsertDevUser(getDb(), userData);

      // Login user
      req.login(user, (err) => {
        if (err) {
          return res.status(500).json({ error: 'Login failed' });
        }
        res.json(toSelf(user));
      });
    } catch (error) {
      logger.error({ err: error }, 'Dev login error');
      res.status(500).json({ error: 'Login failed' });
    }
  }));
}

/**
 * La porte sans compte : un lien de salon, et rien d'autre.
 *
 * C'est la seule route non authentifiée de ce serveur qui crée une ligne, donc
 * tout ici est écrit pour cette phrase-là.
 *
 * - L'ordre des refus vit dans `anonymousDoorDecision`, une fonction pure, et
 *   pas ici : c'est une décision d'autorisation, elle doit être lisible et
 *   testable sans monter un serveur.
 * - Chaque tentative est comptée, réussie ou non. `friendLookupLimit` ne compte
 *   que les échecs parce qu'une réussite y est gratuite ; ici une réussite pose
 *   une ligne, donc ne compter que les refus reviendrait à ne pas compter.
 * - Le salon est relu ici, après la décision, parce que rien ne le garantit
 *   entre les deux : `joinRoom` refait le contrôle de capacité au moment de
 *   s'asseoir, et c'est lui qui fait autorité. Cette vérification-ci sert à ne
 *   pas créer une ligne pour une porte qui ne mène nulle part.
 * - L'identifiant du salon est écrit dans la session, jamais rendu au client
 *   comme un jeton : c'est ce qui fait qu'un lien reçu ouvre une porte et pas
 *   le bâtiment.
 *
 * Ce que cette route ne donne pas : une bibliothèque, des amis, un profil, un
 * pseudonyme réservé. `requirePseudo` refuse toutes les routes `/api` à un
 * anonyme, et `anonymous-gate.ts` la moitié des événements du socket.
 */
authRouter.post('/anonymous', asyncHandler(async (req, res) => {
  // `req.ip` respecte `trust proxy`, qui est armé derrière nginx : sans cela
  // le plafond serait posé sur l'adresse du reverse proxy, c'est-à-dire sur
  // tout le monde à la fois.
  const key = req.ip ?? 'unknown';
  const roomId = typeof req.body?.roomId === 'string' ? req.body.roomId : '';
  const room = roomId ? getRooms().get(roomId) : undefined;

  const decision = anonymousDoorDecision({
    enabled: anonymousJoinEnabled(),
    signedIn: Boolean(req.user),
    blocked: anonymousDoorLimit.blocked(key),
    room: room ? { players: room.players.length } : null,
    pseudo: req.body?.pseudo
  });

  anonymousDoorLimit.record(key);

  if (!decision.ok) {
    logger.info({ error: decision.error, roomId }, 'Anonymous door refused');
    return res.status(decision.status).json({ error: decision.error });
  }

  let user;
  try {
    user = createAnonymousUser(getDb(), { pseudo: decision.pseudo });
  } catch (err) {
    // Les dix mille discriminateurs de ce pseudonyme sont pris. Un 409 comme
    // /api/pseudo, pas un 500 : c'est une réponse sur laquelle le demandeur
    // peut agir - en tapant un autre nom - et pas une panne.
    if (err instanceof PseudoFullError) {
      return res.status(409).json({ error: 'PSEUDO_FULL' });
    }
    throw err;
  }

  req.login(user, err => {
    if (err) {
      logger.error({ err }, 'Anonymous login failed');
      // La ligne ne doit pas survivre à la session qu'elle devait porter.
      deleteAnonymousUser(getDb(), user.id);
      return res.status(500).json({ error: 'Login failed' });
    }
    // Après `req.login` : passport régénère la session, et un champ posé avant
    // serait perdu sans un bruit.
    req.session.anonymousRoomId = room!.id;
    logger.info({ userId: user.id, roomId: room!.id }, 'Anonymous player admitted to a room');
    res.json(toSelf(user));
  });
}));

// Get auth mode
authRouter.get('/mode', (req, res) => {
  res.json({ mode: AUTH_MODE, anonymousJoin: anonymousJoinEnabled() });
});

/**
 * What a player is told about themselves.
 *
 * This used to be `res.json(req.user)`, which serialised the whole row -
 * googleId, controlsConfig and both timestamps went to the browser on every
 * page load. The shape is written out rather than deleted from a copy, so a
 * column added to User later cannot join it by accident.
 *
 * needsPseudo is computed here rather than shipping pseudoChosenAt raw: the
 * client needs the verdict, not the date, and a boolean cannot be
 * misread. backend/test/self-view.test.ts asserts the exact key set.
 */
export function toSelf(user: User) {
  return {
    id: user.id,
    pseudo: user.pseudo,
    discriminator: user.discriminator,
    avatar: user.avatar,
    /**
     * Ce joueur est entré par un lien de salon, sans compte.
     *
     * Le client en a besoin pour deux choses qu'il ne peut pas deviner : ne
     * pas offrir une bibliothèque, des amis ni un profil derrière des routes
     * qui répondront 403, et ne pas lever la modale d'embarquement - voir
     * `needsPseudo` juste en dessous.
     */
    isAnonymous: user.isAnonymous,
    /**
     * Faux pour un anonyme, dont `pseudoChosenAt` est pourtant null.
     *
     * C'est la même troisième branche que `requirePseudo`, du côté du client :
     * sans elle la modale bloquante s'ouvrirait devant quelqu'un qui n'a pas
     * de compte à embarquer, et la seule route ouverte pour en sortir lui
     * donnerait un handle définitif au nom d'une session qui va disparaître.
     */
    needsPseudo: !user.isAnonymous && user.pseudoChosenAt === null
  };
}

/**
 * Who the caller is, or a plain null when they are nobody.
 *
 * 200 rather than the 401 this used to answer. "Nobody is signed in" is a true
 * answer to *this* question, not a refusal: the landing page asks it on every
 * first visit, and a 401 made Chrome write "Failed to load resource: the
 * server responded with a status of 401" into the console of an entirely
 * ordinary visit. That line comes from the network stack, not from our code,
 * so no amount of catching around the fetch can silence it - the endpoint is
 * the only place it can be fixed. It also cost a point in Lighthouse's
 * errors-in-console, which is what finally surfaced it.
 *
 * Nothing else relaxes: every route that guards a resource still answers 401.
 * This one is the question, not the resource.
 */
authRouter.get('/me', (req, res) => {
  res.json(req.user ? toSelf(req.user as User) : null);
});

authRouter.post('/logout', (req, res) => {
  /*
   * Lu avant `req.logout`, qui vide `req.user`.
   *
   * Une session anonyme n'a rien à laisser derrière elle : sa ligne ne porte
   * aucun jeu, aucun ami, aucune sauvegarde - toutes ces routes lui sont
   * fermées - et personne ne peut se reconnecter dessus. `deleteAnonymousUser`
   * refuse tout ce qui n'est pas anonyme, donc l'identifiant venu de la
   * session ne peut pas emporter le compte de quelqu'un d'autre par ses
   * cascades.
   *
   * Ce n'est pas le seul chemin : une session qu'on abandonne sans se
   * déconnecter est ramassée par `sweepAnonymousUsers`. Celui-ci est le chemin
   * propre, celui-là le filet.
   */
  const leaving = req.user as User | undefined;

  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    if (leaving?.isAnonymous) {
      deleteAnonymousUser(getDb(), leaving.id);
      logger.info({ userId: leaving.id }, 'Anonymous session ended and its row removed');
    }
    res.json({ message: 'Logged out successfully' });
  });
});
