/**
 * La porte branchée sur une vraie base.
 *
 * `signup-door.test.ts` épingle l'ordre des refus sur une fonction pure ; ce
 * fichier-ci vérifie que ce qu'on lui donne à décider vient bien de la base --
 * le quota du bon inviteur, le compte des vrais comptes.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { admitSignup } from '../src/auth/signup-door.js';
import { mintInvite, consumeInvite } from '../src/db/signup-invites.js';

test('un code valide est admis, et rend la ligne à consommer', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);

  const decision = admitSignup(db, { code: invite.code, signedIn: false, blocked: false });

  assert.equal(decision.ok, true);
  assert.equal(decision.ok && decision.invite.id, invite.id);
});

test('aucun code du tout est un code inconnu', () => {
  const db = migratedDb();
  const decision = admitSignup(db, { code: undefined, signedIn: false, blocked: false });
  assert.equal(!decision.ok && decision.error, 'INVITE_UNKNOWN');
});

test('le quota lu est celui de l\'inviteur du lien, pas d\'un autre', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);
  const carol = insertUser(db);
  const dave = insertUser(db);

  // Alice a tout dépensé, Bob n'a rien dépensé.
  consumeInvite(db, mintInvite(db, alice.id).id, carol.id);
  consumeInvite(db, mintInvite(db, alice.id).id, dave.id);
  const fromAlice = mintInvite(db, alice.id);
  const fromBob = mintInvite(db, bob.id);

  assert.equal(
    admitSignup(db, { code: fromAlice.code, signedIn: false, blocked: false }).ok, false
  );
  assert.equal(
    admitSignup(db, { code: fromBob.code, signedIn: false, blocked: false }).ok, true
  );
});

test('le plafond compte les comptes, pas les invités anonymes', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);
  process.env.MAX_USERS = '2';
  try {
    // alice + un anonyme = 1 compte, il reste une place.
    insertUser(db, { isAnonymous: 1 });
    assert.equal(
      admitSignup(db, { code: invite.code, signedIn: false, blocked: false }).ok, true
    );

    insertUser(db);
    const full = admitSignup(db, { code: invite.code, signedIn: false, blocked: false });
    assert.equal(!full.ok && full.error, 'PLATFORM_FULL');
  } finally {
    delete process.env.MAX_USERS;
  }
});
