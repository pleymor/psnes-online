/**
 * Qui a le droit de faire naître un compte, et dans quel ordre on refuse.
 *
 * `signupDoorDecision` est une fonction pure, sans base ni requête, comme
 * `anonymousDoorDecision` juste à côté : l'ordre des refus est la décision de
 * sécurité, et il doit pouvoir être lu et épinglé sans monter un serveur.
 *
 * `admitSignup` et `signupOrSignIn`, plus bas dans ce même fichier, sont la
 * couche qui va chercher en base ce que `signupDoorDecision` reçoit tout cuit.
 * Le partage de fichier est délibéré : le lecteur voit d'un coup d'œil ce qui
 * est lu et ce qui est décidé -- mais elles ne sont pas pures, et seule
 * `signupDoorDecision` est exhaustivement testée comme telle.
 *
 * `SignupInvite` et non `Invitation` : `Invitation` est déjà pris dans ce
 * dépôt et veut dire « rejoins mon salon » (`db/invitations.ts`). Deux
 * concepts, deux mots.
 */

import { INVITE_QUOTA, type SignupInvite } from '../db/signup-invites.js';

export type SignupRefusal =
  | 'ALREADY_SIGNED_IN'
  | 'PLATFORM_FULL'
  | 'INVITE_UNKNOWN'
  | 'INVITE_REVOKED'
  | 'INVITE_USED'
  | 'QUOTA_EXHAUSTED'
  | 'TOO_MANY_ATTEMPTS';

export type SignupDecision =
  | { ok: true; invite: SignupInvite }
  | { ok: false; status: number; error: SignupRefusal };

/**
 * Trois choses se jouent dans l'ordre ci-dessous :
 *
 * - `PLATFORM_FULL` passe AVANT la validation du code. L'inverse offrirait un
 *   compteur de places restantes à qui détient un lien mort : « code inconnu »
 *   voudrait alors dire « il reste de la place ».
 * - La limite de tentatives passe avant la lecture du code, pour la même
 *   raison que dans `anonymousDoorDecision` : sans cela, chaque tentative
 *   bloquée resterait un test d'existence gratuit.
 * - Révoqué l'emporte sur consommé. Les deux ne devraient jamais coexister
 *   (`consumeInvite` refuse un lien révoqué, `revokeInvite` un lien consommé),
 *   mais si une ligne portait les deux, la réponse doit être déterministe et
 *   non dépendante de l'ordre où les `if` ont été tapés.
 */
export function signupDoorDecision(input: {
  signedIn: boolean;
  blocked: boolean;
  accounts: number;
  maxUsers: number;
  invite: SignupInvite | null;
  /** Places déjà dépensées par l'inviteur, hors invitations frappées au CLI. */
  inviterCharged: number;
}): SignupDecision {
  if (input.signedIn) {
    return { ok: false, status: 400, error: 'ALREADY_SIGNED_IN' };
  }
  if (input.blocked) {
    return { ok: false, status: 429, error: 'TOO_MANY_ATTEMPTS' };
  }
  if (input.accounts >= input.maxUsers) {
    return { ok: false, status: 503, error: 'PLATFORM_FULL' };
  }
  if (!input.invite) {
    return { ok: false, status: 404, error: 'INVITE_UNKNOWN' };
  }
  if (input.invite.revokedAt) {
    return { ok: false, status: 410, error: 'INVITE_REVOKED' };
  }
  if (input.invite.usedAt) {
    return { ok: false, status: 410, error: 'INVITE_USED' };
  }
  // Une invitation frappée au CLI est l'échappatoire du propriétaire : elle ne
  // débite personne, donc le quota de l'inviteur ne la concerne pas.
  if (!input.invite.grantedByCli && input.inviterCharged > INVITE_QUOTA) {
    return { ok: false, status: 403, error: 'QUOTA_EXHAUSTED' };
  }
  return { ok: true, invite: input.invite };
}

import type { Database } from '../db/sqlite.js';
import { countAccounts, countChargedInvites, findInviteByCode, maxUsers } from '../db/signup-invites.js';

/**
 * Ce que la porte a besoin de savoir, lu en base.
 *
 * Séparée de `signupDoorDecision` : celle-ci décide et se teste sans rien
 * monter, celle-là va chercher. Le partage est délibéré -- une lecture ratée
 * ne doit pas pouvoir se faire passer pour une décision.
 */
export function admitSignup(
  db: Database,
  input: { code: string | undefined; signedIn: boolean; blocked: boolean }
): SignupDecision {
  const invite = input.code ? findInviteByCode(db, input.code) : null;
  return signupDoorDecision({
    signedIn: input.signedIn,
    blocked: input.blocked,
    accounts: countAccounts(db),
    maxUsers: maxUsers(),
    invite,
    inviterCharged: invite ? countChargedInvites(db, invite.inviterId) : 0
  });
}

/**
 * Le code d'invitation que porte la session, entre le clic sur le lien et le
 * retour de Google.
 *
 * Dans la session du serveur et pas dans le paramètre `state` d'OAuth : `state`
 * revient du navigateur, donc d'un endroit que l'utilisateur contrôle. Ce
 * champ-là ne peut être posé que par notre propre route.
 */
declare module 'express-session' {
  interface SessionData {
    pendingInviteCode?: string;
  }
}

import type { User } from '../db/types.js';

export type SignupOrSignInResult =
  | { kind: 'signin'; user: User }
  | { kind: 'signup'; invite: SignupInvite }
  | { kind: 'refused'; error: SignupRefusal };

/**
 * Se reconnecter ou s'inscrire : la décision entière du rappel Google, sans
 * l'écrire.
 *
 * Un `existingUser` posé court-circuite la porte -- `kind: 'signin'` sans
 * jamais appeler `admitSignup`, quels que soient `code` et `blocked`. Se
 * reconnecter n'est pas s'inscrire : baisser `MAX_USERS` ne doit jamais
 * mettre dehors un joueur déjà installé, et un lien d'invitation traînant
 * dans la session d'un compte existant ne doit rien lui coûter.
 *
 * Ne fait aucune écriture. `createUser` et `consumeInvite` restent dans le
 * rappel Google (`auth/passport.ts`), immédiats et sans `await` entre eux --
 * voir la note à cet endroit. Cette fonction s'arrête à la décision, ce qui la
 * rend testable sans monter de serveur, de session, ni de route -- ce dépôt
 * n'a pas de harnais de route (`backend/test/user-config.test.ts` le
 * documente), donc c'est le seul endroit où les trois branches (`signin` /
 * `signup` / `refused`) du rappel Google peuvent être épinglées.
 */
export function signupOrSignIn(
  db: Database,
  input: { existingUser: User | null; code: string | undefined; blocked: boolean }
): SignupOrSignInResult {
  if (input.existingUser) {
    return { kind: 'signin', user: input.existingUser };
  }
  const decision = admitSignup(db, { code: input.code, signedIn: false, blocked: input.blocked });
  return decision.ok
    ? { kind: 'signup', invite: decision.invite }
    : { kind: 'refused', error: decision.error };
}
