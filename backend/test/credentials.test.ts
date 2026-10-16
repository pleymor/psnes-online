/**
 * L'adresse, le hash, et les deux jetons — sur une vraie base migrée.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { hashPassword } from '../src/auth/password.js';
import { newToken } from '../src/auth/tokens.js';
import {
  createCredential, emailTaken, findCredentialByEmail, setPasswordHash
} from '../src/db/credentials.js';
import {
  PENDING_SIGNUP_TTL_MS, createPendingSignup, deletePendingSignup,
  findLivePendingSignupByToken, inviteIsHeld
} from '../src/db/pending-signups.js';
import {
  PASSWORD_RESET_TTL_MS, createPasswordReset, findLiveResetByToken, useReset
} from '../src/db/password-resets.js';
import { createPasswordUser } from '../src/db/users.js';
import { mintInvite, revokeInvite } from '../src/db/signup-invites.js';

// Un hash réel mais calculé une fois : argon2 coûte, et aucun de ces tests ne
// vérifie le mot de passe lui-même.
const HASH = await hashPassword('correct horse');

test('un compte à mot de passe n\'a pas de googleId, et n\'est pas anonyme', () => {
  const db = migratedDb();
  const user = createPasswordUser(db);
  assert.equal(user.googleId, null);
  assert.equal(user.isAnonymous, false);
  // Il tombe dans le portique d'embarquement existant, comme un compte Google.
  assert.equal(user.pseudoChosenAt, null);
});

test('l\'adresse est unique quelle que soit la casse', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);
  createCredential(db, alice.id, 'Alice@Example.fr', HASH);

  assert.equal(emailTaken(db, 'alice@example.fr'), true);
  assert.equal(emailTaken(db, 'ALICE@EXAMPLE.FR'), true);
  assert.equal(emailTaken(db, 'bob@example.fr'), false);
  assert.throws(() => {
    createCredential(db, bob.id, 'alice@EXAMPLE.fr', 'peu importe');
  });
});

test('l\'adresse est rendue telle qu\'elle a été tapée', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  createCredential(db, alice.id, 'Alice@Example.fr', HASH);

  // C'est ce qui part dans le champ To: ; normaliser en minuscules casserait
  // les rares serveurs à casse significative. Seule la comparaison est
  // insensible.
  assert.equal(findCredentialByEmail(db, 'alice@example.fr')?.email, 'Alice@Example.fr');
});

test('réécrire le hash ne touche pas à l\'adresse', async () => {
  const db = migratedDb();
  const alice = insertUser(db);
  createCredential(db, alice.id, 'alice@example.fr', HASH);

  const next = await hashPassword('nouveau mot de passe');
  setPasswordHash(db, alice.id, next);

  const after = findCredentialByEmail(db, 'alice@example.fr');
  assert.equal(after?.passwordHash, next);
  assert.equal(after?.email, 'alice@example.fr');
});

test('supprimer un compte emporte ses identifiants', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  createCredential(db, alice.id, 'alice@example.fr', HASH);

  db.query(`DELETE FROM "User" WHERE id = ?`).run(alice.id);

  assert.equal(findCredentialByEmail(db, 'alice@example.fr'), null);
});

test('une inscription en attente retient son invitation, puis la rend', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);
  const { hash } = newToken();
  const t0 = 1_700_000_000_000;

  createPendingSignup(db, {
    email: 'bob@example.fr', passwordHash: HASH, inviteId: invite.id, tokenHash: hash, now: t0
  });

  assert.equal(inviteIsHeld(db, invite.id, t0), true);
  assert.ok(findLivePendingSignupByToken(db, hash, t0));

  // Vingt-quatre heures plus tard, la place est revenue d'elle-même : la
  // retenue est l'absence de ligne expirée, pas une colonne à nettoyer.
  const later = t0 + PENDING_SIGNUP_TTL_MS + 1;
  assert.equal(inviteIsHeld(db, invite.id, later), false);
  assert.equal(findLivePendingSignupByToken(db, hash, later), null);
  assert.equal(findLivePendingSignupByToken(db, newToken().hash, t0), null);
});

test('une inscription en attente ne se retient pas elle-même', () => {
  // Sans cette exemption, la confirmation se refuserait avec INVITE_HELD --
  // sa propre attente retient le lien qu'elle vient utiliser -- et aucune
  // inscription par mot de passe n'aboutirait jamais.
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);
  const pending = createPendingSignup(db, {
    email: 'bob@example.fr', passwordHash: HASH, inviteId: invite.id, tokenHash: newToken().hash
  });

  assert.equal(inviteIsHeld(db, invite.id, Date.now(), pending.id), false);
  assert.equal(inviteIsHeld(db, invite.id, Date.now(), 'une-autre-attente'), true);
});

test('confirmer supprime l\'attente, et rend la retenue', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);
  const { hash } = newToken();
  const pending = createPendingSignup(db, {
    email: 'bob@example.fr', passwordHash: HASH, inviteId: invite.id, tokenHash: hash
  });

  deletePendingSignup(db, pending.id);

  assert.equal(inviteIsHeld(db, invite.id), false);
  assert.equal(findLivePendingSignupByToken(db, hash), null);
});

test('révoquer l\'invitation n\'annule pas l\'attente en base, mais la porte la refusera', () => {
  // `revokeInvite` pose `revokedAt` sans supprimer la ligne : la cascade ne
  // joue donc pas, et c'est la porte, reconsultée à la confirmation, qui
  // refuse INVITE_REVOKED (credentials-api.test.ts).
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);
  const { hash } = newToken();
  createPendingSignup(db, {
    email: 'bob@example.fr', passwordHash: HASH, inviteId: invite.id, tokenHash: hash
  });

  revokeInvite(db, invite.id);

  assert.ok(findLivePendingSignupByToken(db, hash));
});

test('un jeton de réinitialisation vaut une heure et une seule fois', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const { hash } = newToken();
  const t0 = Date.now();

  createPasswordReset(db, alice.id, hash, t0);
  const found = findLiveResetByToken(db, hash, t0);
  assert.equal(found?.userId, alice.id);

  assert.equal(useReset(db, found!.id), true);
  assert.equal(findLiveResetByToken(db, hash, t0), null);
  // Le second clic sur le même lien ne trouve plus rien à brûler.
  assert.equal(useReset(db, found!.id), false);
});

test('une nouvelle demande éteint les précédentes', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const first = newToken();
  const second = newToken();
  const t0 = 1_700_000_000_000;

  createPasswordReset(db, alice.id, first.hash, t0);
  createPasswordReset(db, alice.id, second.hash, t0 + 1000);

  // Un ancien lien encore dans une boîte mail ne doit pas rester une clé
  // vivante.
  assert.equal(findLiveResetByToken(db, first.hash, t0 + 1000), null);
  assert.ok(findLiveResetByToken(db, second.hash, t0 + 1000));
});

test('un jeton de réinitialisation expire', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const { hash } = newToken();
  const t0 = 1_700_000_000_000;

  createPasswordReset(db, alice.id, hash, t0);

  assert.equal(findLiveResetByToken(db, hash, t0 + PASSWORD_RESET_TTL_MS + 1), null);
});
