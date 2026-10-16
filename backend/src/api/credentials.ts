/**
 * La seconde porte : e-mail + mot de passe, à côté de Google (#68).
 *
 * Le mail EST la vérification. `/signup` ne crée aucun compte, seulement une
 * attente et un mail ; le compte naît au clic, dans `confirmSignup`. Aucune
 * ligne "User" non confirmée n'existe donc jamais, et aucun état « compte non
 * vérifié » n'a à traverser le reste de l'application.
 *
 * Une méthode par compte pour l'instant : un compte Google n'a pas de ligne
 * "Credential", donc ni connexion par mot de passe, ni « mot de passe oublié ».
 */

import { Router } from 'express';
import { getDb, type Database } from '../db/sqlite.js';
import { admitSignup } from '../auth/signup-door.js';
import { passwordAuthEnabled, signupFormDecision } from '../auth/credentials-door.js';
import { burnTime, hashPassword, passwordAcceptable, verifyPassword } from '../auth/password.js';
import { hashToken, newToken } from '../auth/tokens.js';
import { destroySessionsOf } from '../auth/sessions.js';
import { consumeInvite } from '../db/signup-invites.js';
import {
  createCredential, emailTaken, findCredentialByEmail, setPasswordHash
} from '../db/credentials.js';
import {
  createPendingSignup, deletePendingSignup, findLivePendingSignupByToken
} from '../db/pending-signups.js';
import {
  createPasswordReset, findLiveResetByToken, useReset
} from '../db/password-resets.js';
import { createPasswordUser, findUserById } from '../db/users.js';
import { passwordResetMail, sendMail, signupConfirmationMail } from '../services/mailer.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { credentialLoginLimit, inviteLookupLimit, passwordMailLimit } from '../utils/attempt-limit.js';
import type { User } from '../db/types.js';
import { toSelf } from './auth.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Credentials');

export const credentialsRouter = Router();

function frontendUrl(): string {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function bodyString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export type ConfirmResult =
  | { ok: true; user: User }
  | { ok: false; status: number; error: string };

/**
 * Le compte naît ici, et nulle part ailleurs.
 *
 * Quatre écritures dans UNE transaction : le compte, l'identifiant,
 * l'invitation consommée, l'attente effacée. Séparées, un échec au milieu
 * laisserait un compte sans mot de passe, ou une invitation dépensée pour
 * personne.
 *
 * La porte est reconsultée DANS la transaction. Vingt-quatre heures ont pu
 * passer depuis le formulaire : la centième place a pu partir, et l'invitation
 * a pu être révoquée par celui qui l'avait donnée. `ignoreHeldId` exempte
 * cette inscription de sa propre retenue -- sans lui, elle se refuserait
 * elle-même avec INVITE_HELD.
 *
 * Exportée séparément du routeur pour être testable sans serveur HTTP -- c'est
 * la partie qui mérite d'être épinglée.
 */
export function confirmSignup(db: Database, token: string): ConfirmResult {
  const pending = findLivePendingSignupByToken(db, hashToken(token));
  if (!pending) {
    return { ok: false, status: 410, error: 'TOKEN_INVALID' };
  }

  const run = db.transaction((): ConfirmResult => {
    const invite = db.query(`SELECT code FROM "SignupInvite" WHERE id = ?`)
      .get(pending.inviteId) as { code: string } | null;
    const decision = admitSignup(db, {
      code: invite?.code,
      signedIn: false,
      blocked: false,
      ignoreHeldId: pending.id
    });
    if (!decision.ok) {
      return { ok: false, status: decision.status, error: decision.error };
    }
    // Une autre invitation a pu confirmer la même adresse entre-temps :
    // l'index unique le refuserait de toute façon, mais un refus lisible vaut
    // mieux qu'une contrainte qui remonte en 500.
    if (emailTaken(db, pending.email)) {
      return { ok: false, status: 409, error: 'EMAIL_TAKEN' };
    }

    const user = createPasswordUser(db);
    createCredential(db, user.id, pending.email, pending.passwordHash);
    consumeInvite(db, pending.inviteId, user.id);
    deletePendingSignup(db, pending.id);
    return { ok: true, user };
  });

  return run();
}

/** Le formulaire. Ne crée aucun compte : seulement une attente et un mail. */
credentialsRouter.post('/signup', asyncHandler(async (req, res) => {
  // 404 avant tout le reste, et sans compter la tentative : quand la porte est
  // fermée, cette route n'existe pas.
  if (!passwordAuthEnabled()) return res.status(404).json({ error: 'PASSWORD_AUTH_DISABLED' });

  const db = getDb();
  const key = req.ip ?? 'unknown';

  const door = admitSignup(db, {
    code: typeof req.body?.code === 'string' ? req.body.code : undefined,
    signedIn: Boolean(req.user),
    blocked: inviteLookupLimit.blocked(key)
  });
  inviteLookupLimit.record(key);
  if (!door.ok) return res.status(door.status).json({ error: door.error });

  const form = signupFormDecision({
    enabled: true,
    email: req.body?.email,
    password: req.body?.password,
    emailTaken: emailTaken(db, bodyString(req.body?.email))
  });
  if (!form.ok) return res.status(form.status).json({ error: form.error });

  const passwordHash = await hashPassword(form.password);

  // Relu après l'`await` du hachage : une seconde soumission du même lien a
  // pu poser sa retenue pendant ces cinquante millisecondes. Sans cette
  // relecture, les deux attentes coexisteraient -- la confirmation n'en
  // laisserait passer qu'une, mais deux mails seraient partis.
  const again = admitSignup(db, { code: door.invite.code, signedIn: false, blocked: false });
  if (!again.ok) return res.status(again.status).json({ error: again.error });

  const { token, hash } = newToken();
  createPendingSignup(db, {
    email: form.email,
    passwordHash,
    inviteId: door.invite.id,
    tokenHash: hash
  });

  await sendMail(signupConfirmationMail(
    form.email,
    `${frontendUrl()}/auth/signup/confirm?token=${token}`
  ));

  logger.info({ inviteId: door.invite.id }, 'Signup awaiting mail confirmation');
  res.status(202).json({ ok: true });
}));

/** Le clic dans le mail. C'est ici que le compte existe pour la première fois. */
credentialsRouter.get('/signup/confirm', (req, res, next) => {
  const token = bodyString(req.query.token);
  const result = confirmSignup(getDb(), token);

  if (!result.ok) {
    return res.redirect(`${frontendUrl()}/signup?signupError=${encodeURIComponent(result.error)}`);
  }
  logger.info({ userId: result.user.id }, 'Password account created');
  req.login(result.user, err => {
    if (err) return next(err);
    res.redirect(frontendUrl());
  });
});

credentialsRouter.post('/login', asyncHandler(async (req, res) => {
  if (!passwordAuthEnabled()) return res.status(404).json({ error: 'PASSWORD_AUTH_DISABLED' });

  const email = bodyString(req.body?.email);
  const password = bodyString(req.body?.password);
  // Deux clés : l'adresse, pour qu'un attaquant distribué ne balaye pas un
  // compte depuis mille adresses IP ; l'IP, pour qu'il ne balaye pas mille
  // comptes depuis une seule.
  const keys = [`ip:${req.ip ?? 'unknown'}`, `mail:${email.toLowerCase()}`];
  if (keys.some(k => credentialLoginLimit.blocked(k))) {
    return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  }

  const db = getDb();
  const credential = findCredentialByEmail(db, email);
  // Une adresse inconnue coûte le même temps qu'un mauvais mot de passe :
  // sans cela, la durée de réponse seule dit qui a un compte ici. Un mot de
  // passe démesuré n'est même pas haché -- il ne peut pas être le bon.
  let good = false;
  if (credential && passwordAcceptable(password)) {
    good = await verifyPassword(password, credential.passwordHash);
  } else {
    await burnTime();
  }

  const user = good ? findUserById(db, credential!.userId) : null;
  if (!user) {
    for (const k of keys) credentialLoginLimit.record(k);
    return res.status(401).json({ error: 'BAD_CREDENTIALS' });
  }

  req.login(user, err => {
    if (err) return res.status(500).json({ error: 'Login failed' });
    res.json(toSelf(user));
  });
}));

/**
 * Toujours 200, toujours le même corps.
 *
 * Une réponse différenciée serait un test d'existence de compte gratuit, sur
 * une route ouverte à n'importe qui. Un compte Google n'a pas de Credential :
 * il tombe dans la même branche silencieuse que l'adresse inconnue.
 */
credentialsRouter.post('/forgot', asyncHandler(async (req, res) => {
  const email = bodyString(req.body?.email);
  const keys = [`ip:${req.ip ?? 'unknown'}`, `mail:${email.toLowerCase()}`];

  if (passwordAuthEnabled() && !keys.some(k => passwordMailLimit.blocked(k))) {
    for (const k of keys) passwordMailLimit.record(k);
    const credential = findCredentialByEmail(getDb(), email);
    if (credential) {
      const { token, hash } = newToken();
      createPasswordReset(getDb(), credential.userId, hash);
      try {
        await sendMail(passwordResetMail(credential.email, `${frontendUrl()}/reset?token=${token}`));
        logger.info({ userId: credential.userId }, 'Password reset mail sent');
      } catch (err) {
        // Journalisé, pas rendu : un 500 ici dirait que l'adresse existe.
        logger.error({ err, userId: credential.userId }, 'Password reset mail could not be sent');
      }
    }
  }
  res.json({ ok: true });
}));

credentialsRouter.post('/reset', asyncHandler(async (req, res) => {
  if (!passwordAuthEnabled()) return res.status(404).json({ error: 'PASSWORD_AUTH_DISABLED' });

  const db = getDb();
  const token = bodyString(req.body?.token);
  const password = req.body?.password;

  if (!passwordAcceptable(password)) {
    return res.status(400).json({ error: 'PASSWORD_TOO_SHORT' });
  }
  const reset = findLiveResetByToken(db, hashToken(token));
  if (!reset) return res.status(410).json({ error: 'TOKEN_INVALID' });

  const hash = await hashPassword(password);
  // `useReset` est l'arbitre : deux clics simultanés sur le même lien ont tous
  // les deux passé la lecture ci-dessus, un seul brûle le jeton.
  const applied = db.transaction(() => {
    if (!useReset(db, reset.id)) return false;
    setPasswordHash(db, reset.userId, hash);
    return true;
  })();
  if (!applied) return res.status(410).json({ error: 'TOKEN_INVALID' });

  // Après l'écriture, jamais avant : si la fermeture échoue, le mot de passe
  // est tout de même changé, et c'est le bon sens de l'échec.
  try {
    await destroySessionsOf(req.sessionStore, reset.userId);
  } catch (err) {
    logger.error({ err, userId: reset.userId }, 'Could not close sessions after a password reset');
  }

  const user = findUserById(db, reset.userId);
  if (!user) return res.status(410).json({ error: 'TOKEN_INVALID' });
  req.login(user, err => {
    if (err) return res.status(500).json({ error: 'Login failed' });
    res.json(toSelf(user));
  });
}));
