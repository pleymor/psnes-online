/**
 * La porte branchée sur une vraie base.
 *
 * `signup-door.test.ts` épingle l'ordre des refus sur une fonction pure ; ce
 * fichier-ci vérifie que ce qu'on lui donne à décider vient bien de la base --
 * le quota du bon inviteur, le compte des vrais comptes.
 *
 * La deuxième moitié épingle `signupOrSignIn`, la décision entière du rappel
 * Google (se reconnecter / s'inscrire / refuser) : ce dépôt n'a pas de
 * harnais de route, donc c'est la seule façon de tester ces trois branches
 * sans monter un serveur.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { admitSignup, signupOrSignIn } from '../src/auth/signup-door.js';
import { mintInvite, consumeInvite } from '../src/db/signup-invites.js';
import { findUserByGoogleId } from '../src/db/users.js';

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

test('un googleId déjà connu se reconnecte sans consulter la porte', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const existingUser = findUserByGoogleId(db, alice.googleId)!;

  // `blocked: true` et aucun code : la porte refuserait sur les deux motifs
  // si elle était consultée. `kind === 'signin'` prouve qu'elle ne l'est pas.
  const result = signupOrSignIn(db, { existingUser, code: undefined, blocked: true });

  assert.equal(result.kind, 'signin');
  assert.equal(result.kind === 'signin' && result.user.id, existingUser.id);
});

test('un googleId inconnu avec un code valide s\'inscrit', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const invite = mintInvite(db, alice.id);

  const result = signupOrSignIn(db, { existingUser: null, code: invite.code, blocked: false });

  assert.equal(result.kind, 'signup');
  assert.equal(result.kind === 'signup' && result.invite.id, invite.id);
});

test('un googleId inconnu sans code valide est refusé', () => {
  const db = migratedDb();

  const result = signupOrSignIn(db, { existingUser: null, code: undefined, blocked: false });

  assert.equal(result.kind, 'refused');
  assert.equal(result.kind === 'refused' && result.error, 'INVITE_UNKNOWN');
});
