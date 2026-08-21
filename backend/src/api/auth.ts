import { Router } from 'express';
import passport from 'passport';
import { getAuthMode } from '../auth/passport.js';
import { getDb } from '../db/sqlite.js';
import { upsertDevUser } from '../db/users.js';
import { createLogger } from '../utils/logger.js';
import { asyncHandler } from '../middleware/async-handler.js';

const logger = createLogger('Auth');

export const authRouter = Router();

const AUTH_MODE = getAuthMode();

// Google OAuth routes (only available in google mode)
if (AUTH_MODE === 'google') {
  authRouter.get('/google', passport.authenticate('google', {
    // Identity only. The Drive scope is gone with Drive itself: asking a
    // player for read access to their whole Drive was never proportionate to
    // what it bought, and ROMs no longer leave their machine.
    scope: ['profile', 'email']
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

      if (!userId || (userId !== '1' && userId !== '2')) {
        return res.status(400).json({ error: 'Invalid user ID. Must be 1 or 2.' });
      }

      const devUsers = [
        {
          id: 'dev-user-1',
          email: 'user1@dev.local',
          displayName: 'Dev User 1',
          googleId: 'dev-google-id-1',
          avatar: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=DevUser1&backgroundColor=667eea'
        },
        {
          id: 'dev-user-2',
          email: 'user2@dev.local',
          displayName: 'Dev User 2',
          googleId: 'dev-google-id-2',
          avatar: 'https://api.dicebear.com/7.x/pixel-art/svg?seed=DevUser2&backgroundColor=764ba2'
        }
      ];

      const userData = devUsers[parseInt(userId) - 1];

      // Upsert user in database (update avatar if user already exists)
      const user = upsertDevUser(getDb(), userData);

      // Login user
      req.login(user, (err) => {
        if (err) {
          return res.status(500).json({ error: 'Login failed' });
        }
        res.json(user);
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

authRouter.get('/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json(req.user);
});

authRouter.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ message: 'Logged out successfully' });
  });
});
