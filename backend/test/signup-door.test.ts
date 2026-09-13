/**
 * L'ordre des refus EST la décision de sécurité.
 *
 * Testé sur une fonction pure, sans serveur ni base, exactement comme
 * `anonymousDoorDecision` (backend/src/auth/anonymous.ts) : une décision
 * d'autorisation doit pouvoir être lue et épinglée sans monter une pile.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { signupDoorDecision } from '../src/auth/signup-door.js';
import type { SignupInvite } from '../src/db/signup-invites.js';

function invite(over: Partial<SignupInvite> = {}): SignupInvite {
  return {
    id: 'inv-1', code: 'abcdefghijklmnopqrstuv', inviterId: 'alice',
    inviteeId: null, grantedByCli: false,
    createdAt: new Date(), usedAt: null, revokedAt: null,
    ...over
  };
}

const OPEN = {
  signedIn: false, blocked: false, accounts: 10, maxUsers: 100,
  invite: invite(), inviterCharged: 1
};

test('un lien valide sur une plateforme qui a de la place ouvre', () => {
  const decision = signupDoorDecision(OPEN);
  assert.equal(decision.ok, true);
  assert.equal(decision.ok && decision.invite.id, 'inv-1');
});

test('la plateforme pleine refuse AVANT de regarder le code', () => {
  // L'inverse offrirait un compteur de places restantes à qui détient un lien
  // mort : « code inconnu » signifierait alors « il reste de la place ».
  const decision = signupDoorDecision({
    ...OPEN, accounts: 100, maxUsers: 100, invite: null
  });
  assert.equal(decision.ok, false);
  assert.equal(!decision.ok && decision.error, 'PLATFORM_FULL');
  assert.equal(!decision.ok && decision.status, 503);
});

test('une session existante est refusée avant tout le reste', () => {
  const decision = signupDoorDecision({ ...OPEN, signedIn: true, accounts: 100 });
  assert.equal(!decision.ok && decision.error, 'ALREADY_SIGNED_IN');
  assert.equal(!decision.ok && decision.status, 400);
});

test('la limite de tentatives passe avant la lecture du code', () => {
  const decision = signupDoorDecision({ ...OPEN, blocked: true });
  assert.equal(!decision.ok && decision.error, 'TOO_MANY_ATTEMPTS');
  assert.equal(!decision.ok && decision.status, 429);
});

test('un code inconnu, un code révoqué et un code consommé sont trois réponses', () => {
  // Distinctes exprès : le porteur d'un lien mort a le droit de savoir que le
  // lien a existé, et le dire ne lui apprend rien qu'il ne détienne déjà.
  const unknown = signupDoorDecision({ ...OPEN, invite: null });
  assert.equal(!unknown.ok && unknown.error, 'INVITE_UNKNOWN');
  assert.equal(!unknown.ok && unknown.status, 404);

  const revoked = signupDoorDecision({ ...OPEN, invite: invite({ revokedAt: new Date() }) });
  assert.equal(!revoked.ok && revoked.error, 'INVITE_REVOKED');
  assert.equal(!revoked.ok && revoked.status, 410);

  const used = signupDoorDecision({
    ...OPEN, invite: invite({ usedAt: new Date(), inviteeId: 'bob' })
  });
  assert.equal(!used.ok && used.error, 'INVITE_USED');
  assert.equal(!used.ok && used.status, 410);
});

test('révoqué l\'emporte sur consommé quand une ligne porte les deux', () => {
  // consumeInvite refuse un lien révoqué et revokeInvite un lien consommé,
  // donc la ligne ne devrait pas exister. Si elle existe, la réponse doit être
  // déterministe plutôt que dépendante de l'ordre des `if`.
  const decision = signupDoorDecision({
    ...OPEN, invite: invite({ usedAt: new Date(), revokedAt: new Date() })
  });
  assert.equal(!decision.ok && decision.error, 'INVITE_REVOKED');
});

test('le lien en cours de consommation est LUI-MÊME compté, donc 2 passe', () => {
  // La borne, et elle est contre-intuitive : `countChargedInvites` compte
  // toutes les invitations non révoquées, celle qu'on est en train d'utiliser
  // comprise. Un inviteur qui a distribué ses deux liens est à 2, et son
  // deuxième filleul doit pouvoir entrer. Refuser à 2 fermerait la seconde
  // place à tout le monde -- un hors-par-un qui ne se verrait qu'en
  // production, sur la deuxième invitation de chaque joueur.
  assert.equal(signupDoorDecision({ ...OPEN, inviterCharged: 2 }).ok, true);
});

test('un inviteur au-delà de son quota ne fait plus entrer personne', () => {
  // 3 places non révoquées ne peut venir que d'un contournement de POST
  // /api/invites, qui refuse à partir de 2. La porte le rattrape.
  const decision = signupDoorDecision({ ...OPEN, inviterCharged: 3 });
  assert.equal(!decision.ok && decision.error, 'QUOTA_EXHAUSTED');
  assert.equal(!decision.ok && decision.status, 403);
});

test('un lien frappé par le CLI ouvre même si son inviteur est au-delà', () => {
  // 3 et non 2 : à 2 la porte ouvre de toute façon, donc le test réussirait
  // même si `grantedByCli` était ignoré. À 3 il échoue si l'exemption
  // disparaît, ce qui est tout ce qu'on lui demande.
  const decision = signupDoorDecision({
    ...OPEN, invite: invite({ grantedByCli: true }), inviterCharged: 3
  });
  assert.equal(decision.ok, true);
});
