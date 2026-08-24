import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { getDb } from '../db/sqlite.js';
import { findUserByGoogleId, findUserById, createUser, updateUserAvatar } from '../db/users.js';
import { downloadAvatar } from '../utils/avatar.js';
import { logger } from '../utils/logger.js';

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
        // Both tokens are deliberately ignored: this app authenticates and
        // never calls Google on the user's behalf. Naming them with an
        // underscore is what stops someone re-adding accessType: 'offline' to
        // "fix" a token that nothing wants.
        async (_accessToken, _refreshToken, profile, done) => {
          try {
            const db = getDb();
            let user = findUserByGoogleId(db, profile.id);

            // Only two things are read off the Google profile: the account id,
            // which is the join key, and the photo. profile.displayName - the
            // civil name - is deliberately never touched, and profile.emails
            // is empty now that the 'email' scope is no longer requested.
            //
            // The OAuth tokens are deliberately not kept. They existed to call
            // Drive on the player's behalf; with ROMs staying on their machine
            // there is nothing left to call, and storing a refresh token you
            // never use is a standing liability for no benefit.
            if (!user) {
              user = createUser(db, { googleId: profile.id, avatar: null });
            }

            // The avatar is fetched after the account exists, not before, so
            // its filename can be derived from the internal id. It used to be
            // md5(googleId), which is not the Google id in the clear but is a
            // stable fingerprint of it - and that URL is served to every
            // friend, so anyone holding that Google id from elsewhere could
            // confirm the account was the same person. An internal UUID exists
            // nowhere else. The cost is one extra write, once, at sign-up.
            const googleAvatarUrl = profile.photos?.[0]?.value;
            if (googleAvatarUrl) {
              const downloaded = await downloadAvatar(googleAvatarUrl, user.id);
              user = updateUserAvatar(db, user.id, downloaded || googleAvatarUrl);
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
      const user = findUserById(getDb(), id);
      if (!user) {
        logger.warn({ userId: id }, 'deserializeUser: user not found');
      }
      done(null, user);
    } catch (error) {
      logger.error({ err: error }, 'deserializeUser error');
      done(error);
    }
  });
}

export function getAuthMode() {
  return AUTH_MODE;
}
