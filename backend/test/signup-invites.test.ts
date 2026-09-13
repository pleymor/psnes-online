/**
 * Les places, comptées sur la base plutôt que sur un compteur.
 *
 * Le quota est une requête et non une colonne : une colonne `invitesLeft`
 * dériverait au premier chemin qui oublie de la décrémenter, et rien ne le
 * dirait. Ces tests épinglent le comptage, pas le stockage.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  INVITE_QUOTA, mintInvite, findInviteByCode, listInvitesOf,
  countChargedInvites, revokeInvite, consumeInvite, countAccounts, maxUsers
} from '../src/db/signup-invites.js';

test('un lien frappé est retrouvable par son code, et son code est imprévisible', () => {
  const db = migratedDb();
  const alice = insertUser(db);

  const invite = mintInvite(db, alice.id);

  assert.equal(findInviteByCode(db, invite.code)?.id, invite.id);
  assert.equal(invite.inviteeId, null);
  assert.equal(invite.usedAt, null);
  assert.equal(invite.grantedByCli, false);
  // 128 bits en base64url : 22 caractères, sans remplissage.
  assert.match(invite.code, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(mintInvite(db, alice.id).code, invite.code);
});

test('un lien vivant coûte une place, exactement comme un lien consommé', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);

  const first = mintInvite(db, alice.id);
  assert.equal(countChargedInvites(db, alice.id), 1);

  consumeInvite(db, first.id, bob.id);
  assert.equal(countChargedInvites(db, alice.id), 1);

  mintInvite(db, alice.id);
  assert.equal(countChargedInvites(db, alice.id), INVITE_QUOTA);
});

test('révoquer un lien non consommé rend la place', () => {
  const db = migratedDb();
  const alice = insertUser(db);

  const invite = mintInvite(db, alice.id);
  revokeInvite(db, invite.id);

  assert.equal(countChargedInvites(db, alice.id), 0);
  assert.notEqual(findInviteByCode(db, invite.code)?.revokedAt, null);
});

test('une invitation frappée par le CLI ne débite personne', () => {
  const db = migratedDb();
  const alice = insertUser(db);

  mintInvite(db, alice.id, { grantedByCli: true });

  assert.equal(countChargedInvites(db, alice.id), 0);
  assert.equal(listInvitesOf(db, alice.id).length, 1);
});

test('un filleul qui disparaît laisse la place consommée', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);
  const invite = mintInvite(db, alice.id);
  consumeInvite(db, invite.id, bob.id);

  db.prepare(`DELETE FROM "User" WHERE id = ?`).run(bob.id);

  // ON DELETE SET NULL, pas CASCADE : sans quoi un inviteur recyclerait ses
  // places indéfiniment en faisant tourner des comptes.
  const after = findInviteByCode(db, invite.code);
  assert.equal(after?.inviteeId, null);
  assert.notEqual(after?.usedAt, null);
  assert.equal(countChargedInvites(db, alice.id), 1);
});

test('un inviteur qui disparaît emporte ses liens', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);

  db.prepare(`DELETE FROM "User" WHERE id = ?`).run(alice.id);

  assert.equal(findInviteByCode(db, invite.code), null);
});

test('les anonymes ne comptent pas dans les places de la plateforme', () => {
  const db = migratedDb();
  insertUser(db);
  insertUser(db);
  insertUser(db, { isAnonymous: 1 });

  assert.equal(countAccounts(db), 2);
});

test('le plafond est une variable, pas une constante', () => {
  assert.equal(maxUsers({}), 100);
  assert.equal(maxUsers({ MAX_USERS: '250' }), 250);
  // Une valeur illisible ne doit pas ouvrir la plateforme en grand.
  assert.equal(maxUsers({ MAX_USERS: 'beaucoup' }), 100);
});
