/**
 * Le hachage, la politique, et le temps que coûte un refus.
 *
 * `Bun.password` fait argon2id sans dépendance : le backend démarre déjà sous
 * Bun (`bun dist/index.js`). Ces tests épinglent ce que le dépôt attend de
 * lui, pas l'algorithme lui-même.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, burnTime, hashPassword, passwordAcceptable, verifyPassword
} from '../src/auth/password.js';
import { hashToken, newToken } from '../src/auth/tokens.js';

test('un hash est un argon2id, et jamais le mot de passe', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(hash.includes('correct horse battery'), false);
});

test('deux hachages du même mot de passe diffèrent, et vérifient tous les deux', async () => {
  // Le sel est dans le hash. Sans ce test, un jour où quelqu'un remplacerait
  // Bun.password par un sha256 nu, tout le reste passerait encore.
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('correct horse battery', b), true);
});

test('un mauvais mot de passe est refusé', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse batteri', hash), false);
});

test('un hash illisible rend faux plutôt que de jeter', async () => {
  // Une ligne corrompue ne doit pas rendre 500 sur la page de connexion : elle
  // doit rendre « mot de passe incorrect », comme n'importe quel refus.
  assert.equal(await verifyPassword('peu importe', 'pas-un-hash'), false);
});

test('la politique tient en une longueur', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 10);
  assert.equal(passwordAcceptable('0123456789'), true);
  assert.equal(passwordAcceptable('012345678'), false);
  assert.equal(passwordAcceptable(''), false);
  assert.equal(passwordAcceptable(undefined), false);
  assert.equal(passwordAcceptable(42), false);
  // Aucune règle de composition : c'est la recommandation NIST, et une règle
  // de classes de caractères produit surtout des « Password1! ».
  assert.equal(passwordAcceptable('aaaaaaaaaaaaaaa'), true);
});

test('un mot de passe démesuré est refusé avant d\'être haché', () => {
  assert.equal(passwordAcceptable('a'.repeat(MAX_PASSWORD_LENGTH)), true);
  assert.equal(passwordAcceptable('a'.repeat(MAX_PASSWORD_LENGTH + 1)), false);
});

test('brûler le temps d\'une vérification ne jette pas', async () => {
  await burnTime();
  await burnTime();
});

test('un jeton est imprévisible, et seul son hash est destiné à la base', () => {
  const { token, hash } = newToken();
  assert.match(token, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(hash.length, 64);
  assert.notEqual(hash, token);
  assert.equal(hashToken(token), hash);
  assert.notEqual(newToken().token, token);
});
