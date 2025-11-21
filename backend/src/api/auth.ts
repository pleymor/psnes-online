import { Router } from 'express';
import passport from 'passport';
import { getAuthMode } from '../auth/passport.js';
import { prisma } from '../db/prisma.js';

export const authRouter = Router();

const AUTH_MODE = getAuthMode();

// Google OAuth routes (only available in google mode)
if (AUTH_MODE === 'google') {
  authRouter.get('/google', passport.authenticate('google', {
    scope: ['profile', 'email']
  }));

  authRouter.get('/google/callback',
    passport.authenticate('google', { failureRedirect: '/login' }),
    (req, res) => {
      res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173');
    }
  );
}

// Dev mode authentication routes
if (AUTH_MODE === 'dev') {
  // Login as dev user
  authRouter.post('/dev/login', async (req, res) => {
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
          avatar: '👤'
        },
        {
          id: 'dev-user-2',
          email: 'user2@dev.local',
          displayName: 'Dev User 2',
          googleId: 'dev-google-id-2',
          avatar: '🎮'
        }
      ];

      const userData = devUsers[parseInt(userId) - 1];

      // Upsert user in database
      let user = await prisma.user.findUnique({
        where: { id: userData.id }
      });

      if (!user) {
        user = await prisma.user.create({
          data: userData
        });
      }

      // Login user
      req.login(user, (err) => {
        if (err) {
          return res.status(500).json({ error: 'Login failed' });
        }
        res.json(user);
      });
    } catch (error) {
      console.error('Dev login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  });
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
