import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export function initializeAuth() {
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

          if (!user) {
            user = await prisma.user.create({
              data: {
                googleId: profile.id,
                email,
                displayName: profile.displayName,
                avatar: profile.photos?.[0]?.value
              }
            });
          } else {
            // Update user info
            user = await prisma.user.update({
              where: { id: user.id },
              data: {
                displayName: profile.displayName,
                avatar: profile.photos?.[0]?.value
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
