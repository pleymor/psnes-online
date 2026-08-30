/**
 * What /auth/me tells a player about themselves.
 *
 * This route used to be `res.json(req.user)`, so googleId, controlsConfig and
 * both timestamps reached the browser on every page load. The assertion below
 * is on the exact key set rather than on the fields we expect: the regression
 * to fear is a column joining the payload when it is added to User, and a
 * field-by-field check would not notice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSelf } from '../src/api/auth.js';
import type { User } from '../src/db/types.js';

function user(over: Partial<User> = {}): User {
  return {
    id: 'u1',
    googleId: 'g-secret',
    isAnonymous: false,
    pseudo: 'Sprite',
    discriminator: '0417',
    pseudoChosenAt: new Date(),
    avatar: '/api/avatars/abc.png',
    controlsConfig: '{"up":"ArrowUp"}',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over
  };
}

test('a player is told six things about themselves and no more', () => {
  // Six depuis qu'on peut jouer sans compte. `isAnonymous` a été ajouté ici
  // délibérément : le client doit savoir qu'il n'a pas de bibliothèque à
  // afficher ni de modale d'embarquement à lever, et il ne peut le déduire
  // d'aucune autre clé - `needsPseudo` vaut faux pour un anonyme comme pour un
  // compte installé.
  assert.deepEqual(
    Object.keys(toSelf(user())).sort(),
    ['avatar', 'discriminator', 'id', 'isAnonymous', 'needsPseudo', 'pseudo']
  );
});

test('the Google account id and the key bindings stay on the server', () => {
  const self = toSelf(user()) as Record<string, unknown>;

  assert.equal(self.googleId, undefined);
  assert.equal(self.controlsConfig, undefined,
    'the controls have their own route; they have no business on every page load');
});

test('un anonyme ne se voit jamais demander de pseudonyme', () => {
  // Sa date de choix est null comme celle d'un compte neuf. Sans cette
  // distinction, la modale bloquante s'ouvrirait devant quelqu'un qui n'a pas
  // de compte à embarquer, et la seule route pour en sortir - /api/pseudo -
  // lui est fermée par requireAccount.
  const anon = toSelf(user({ isAnonymous: true, pseudoChosenAt: null }));

  assert.equal(anon.isAnonymous, true);
  assert.equal(anon.needsPseudo, false);
});

test('needsPseudo is the verdict, not the date', () => {
  assert.equal(toSelf(user({ pseudoChosenAt: null })).needsPseudo, true);
  assert.equal(toSelf(user({ pseudoChosenAt: new Date() })).needsPseudo, false);

  const self = toSelf(user()) as Record<string, unknown>;
  assert.equal(self.pseudoChosenAt, undefined, 'the client needs the answer, not the timestamp');
});
