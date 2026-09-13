import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { getDb } from '../db/sqlite.js';
import { findUserByGoogleId, findUserById, createUser, updateUserAvatar } from '../db/users.js';
import { downloadAvatar } from '../utils/avatar.js';
import { logger } from '../utils/logger.js';
import { admitSignup } from './signup-door.js';
import { consumeInvite } from '../db/signup-invites.js';
import { inviteLookupLimit } from '../utils/attempt-limit.js';

const AUTH_MODE = process.env.AUTH_MODE || 'google';

export function initializeAuth() {
  if (AUTH_MODE === 'google') {
    // Google OAuth Strategy
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          callbackURL: process.env.GOOGLE_CALLBACK_URL!,
          // La porte a besoin de la session pour y lire le code d'invitation.
          // C'est la seule raison de ce drapeau ; le reste du rappel ne touche
          // pas à `req`.
          passReqToCallback: true
        },
        async (req, _accessToken, _refreshToken, profile, done) => {
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
            //
            // Se reconnecter n'est pas s'inscrire : un googleId connu ne
            // consulte jamais la porte. Sans cette distinction, baisser
            // MAX_USERS mettrait dehors des joueurs déjà installés.
            if (!user) {
              const code = req.session?.pendingInviteCode;
              const decision = admitSignup(db, {
                code,
                signedIn: false,
                blocked: inviteLookupLimit.blocked(req.ip ?? 'unknown')
              });
              inviteLookupLimit.record(req.ip ?? 'unknown');

              if (!decision.ok) {
                logger.info({ error: decision.error }, 'Signup door refused a Google sign-in');
                // `done(null, false, info)` et non une erreur : ce n'est pas
                // une panne, c'est un refus. `failureRedirect` s'en charge.
                return done(null, false, { message: decision.error });
              }

              user = createUser(db, { googleId: profile.id, avatar: null });
              consumeInvite(db, decision.invite.id, user.id);
              delete req.session.pendingInviteCode;
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
