import { Router } from 'express';
import passport from 'passport';
import { getAuthMode } from '../auth/passport.js';
import { prisma } from '../db/prisma.js';
import { createLogger } from '../utils/logger.js';
import { asyncHandler } from '../middleware/async-handler.js';

const logger = createLogger('Auth');

export const authRouter = Router();

const AUTH_MODE = getAuthMode();

// Google OAuth routes (only available in google mode)
if (AUTH_MODE === 'google') {
  authRouter.get('/google', passport.authenticate('google', {
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/drive.readonly'],
    accessType: 'offline',
    prompt: 'consent'
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
      const user = await prisma.user.upsert({
        where: { id: userData.id },
        update: { avatar: userData.avatar },
        create: userData
      });

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
