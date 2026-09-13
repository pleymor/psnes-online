/**
 * Qui a le droit de faire naître un compte, et dans quel ordre on refuse.
 *
 * Une fonction pure, sans base ni requête, comme `anonymousDoorDecision` juste
 * à côté : l'ordre des refus est la décision de sécurité, et il doit pouvoir
 * être lu et épinglé sans monter un serveur.
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
