import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { prisma } from '../db/prisma.js';
import { downloadAvatar } from '../utils/avatar.js';

const AUTH_MODE = process.env.AUTH_MODE || 'google';

export function initializeAuth() {
  if (AUTH_MODE === 'google') {
    // Google OAuth Strategy
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          callbackURL: process.env.GOOGLE_CALLBACK_URL!
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const email = profile.emails?.[0]?.value;
            if (!email) {
              return done(new Error('No email found in Google profile'));
            }

            let user = await prisma.user.findUnique({
              where: { googleId: profile.id }
            });

            // Download avatar from Google if available
            let avatarUrl = null;
            const googleAvatarUrl = profile.photos?.[0]?.value;
            if (googleAvatarUrl) {
              const downloadedAvatar = await downloadAvatar(googleAvatarUrl, profile.id);
              avatarUrl = downloadedAvatar || googleAvatarUrl; // Fallback to Google URL if download fails
            }

            if (!user) {
              user = await prisma.user.create({
                data: {
                  googleId: profile.id,
                  email,
                  displayName: profile.displayName,
                  avatar: avatarUrl
                }
              });
            } else {
              // Update user info
              user = await prisma.user.update({
                where: { id: user.id },
                data: {
                  displayName: profile.displayName,
                  avatar: avatarUrl
                }
              });
            }

            return done(null, user);
          } catch (error) {
            return done(error as Error);
          }
        }
      )
    );
  }

  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        console.log('⚠️ deserializeUser: user not found for id:', id);
      }
      done(null, user);
    } catch (error) {
      console.error('❌ deserializeUser error:', error);
      done(error);
    }
  });
}

export function getAuthMode() {
  return AUTH_MODE;
}
