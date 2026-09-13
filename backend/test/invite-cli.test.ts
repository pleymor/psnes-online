/**
 * L'échappatoire du propriétaire, testée sans lancer de processus.
 *
 * Le CLI est une fonction de (base, arguments) vers des lignes ; le fichier ne
 * fait que l'appeler avec process.argv. Un CLI qui ne se teste qu'en le
 * lançant n'est pas testé.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { runInviteCli } from '../src/db/invite-cli.js';
import { countChargedInvites, listInvitesOf } from '../src/db/signup-invites.js';

test('grant frappe une invitation hors quota', () => {
  const db = migratedDb();
  const alice = insertUser(db, { pseudo: 'Sprite', discriminator: '0417' });

  const result = runInviteCli(db, ['grant', 'Sprite#0417']);

  assert.equal(result.code, 0);
  assert.equal(listInvitesOf(db, alice.id).length, 1);
  assert.equal(countChargedInvites(db, alice.id), 0);
  assert.match(result.lines.join('\n'), /\?invite=/);
});

test('grant sur un handle inconnu échoue franchement', () => {
  const db = migratedDb();
  const result = runInviteCli(db, ['grant', 'Personne#9999']);
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /Personne#9999/);
});

test('grant refuse un handle malformé plutôt que de deviner', () => {
  const db = migratedDb();
  const result = runInviteCli(db, ['grant', 'Sprite']);
  assert.equal(result.code, 1);
});

test('revoke éteint un lien par son code', () => {
  const db = migratedDb();
  const alice = insertUser(db, { pseudo: 'Sprite', discriminator: '0417' });
  runInviteCli(db, ['grant', 'Sprite#0417']);
  const code = listInvitesOf(db, alice.id)[0].code;

  const result = runInviteCli(db, ['revoke', code]);

  assert.equal(result.code, 0);
  assert.equal(listInvitesOf(db, alice.id).length, 0);
});

test('list dit combien de places sont prises sur la plateforme', () => {
  const db = migratedDb();
  insertUser(db);
  insertUser(db, { isAnonymous: 1 });

  const result = runInviteCli(db, ['list']);

  assert.equal(result.code, 0);
  // Un anonyme ne compte pas : 1 sur 100.
  assert.match(result.lines.join('\n'), /1\s*\/\s*100/);
});

test('une commande inconnue rend l\'usage et un code non nul', () => {
  const db = migratedDb();
  const result = runInviteCli(db, ['offrir']);
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /grant/);
});
