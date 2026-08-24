import { Router } from 'express';
import passport from 'passport';
import { getAuthMode } from '../auth/passport.js';
import { getDb } from '../db/sqlite.js';
import { upsertDevUser } from '../db/users.js';
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

// Get auth mode
authRouter.get('/mode', (req, res) => {
  res.json({ mode: AUTH_MODE });
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
    needsPseudo: user.pseudoChosenAt === null
  };
}

authRouter.get('/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json(toSelf(req.user as User));
});

authRouter.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ message: 'Logged out successfully' });
  });
});
