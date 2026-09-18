/**
 * Ce qu'un siège de salon affiche à la place d'une cote, quand il n'y en a pas.
 *
 * Quatre situations produisent « pas de cote », et elles ne veulent pas dire la
 * même chose. Les confondre donne un écran qui ment : « 1000 » pour quelqu'un
 * qui n'a jamais joué ressemble à un résultat, et deux cases vides sur un jeu
 * non observé promettent qu'elles vont se remplir un jour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ratingDisplay } from '../../frontend/src/lib/ratings/presentation.js';

const CLASSEE = { userId: 'alice', isAnonymous: false, rating: 1016, matches: 3 };
const JAMAIS_JOUE = { userId: 'bob', isAnonymous: false, rating: null, matches: null };
const INVITE = { userId: 'guest', isAnonymous: true, rating: null, matches: null };

test('sans jeu choisi, on ne montre rien', () => {
  assert.deepEqual(
    ratingDisplay({ gameCrc32: null, watched: false, standing: CLASSEE }),
    { kind: 'hidden' }
  );
});

test('sur un jeu que personne ne sait lire, on ne montre rien non plus', () => {
  // Et surtout pas « non classé », qui laisserait croire qu'une partie
  // suffirait à remplir la case.
  assert.deepEqual(
    ratingDisplay({ gameCrc32: 'DEADBEEF', watched: false, standing: CLASSEE }),
    { kind: 'hidden' }
  );
});

test('un siège vide ne montre rien', () => {
  assert.deepEqual(
    ratingDisplay({ gameCrc32: '8F24F886', watched: true, standing: null }),
    { kind: 'hidden' }
  );
});

test('un invité est dit invité, pas non classé', () => {
  // Il n'a pas d'identité durable : sa colonne est NULL dès l'insertion, donc
  // il ne sera JAMAIS classé. « Non classé » suggérerait qu'un combat suffirait.
  assert.deepEqual(
    ratingDisplay({ gameCrc32: '8F24F886', watched: true, standing: INVITE }),
    { kind: 'guest' }
  );
});

test('un compte sans partie sur ce jeu est non classé', () => {
  assert.deepEqual(
    ratingDisplay({ gameCrc32: '8F24F886', watched: true, standing: JAMAIS_JOUE }),
    { kind: 'unranked' }
  );
});

test('un compte qui a joué montre sa cote et son nombre de parties', () => {
  assert.deepEqual(
    ratingDisplay({ gameCrc32: '8F24F886', watched: true, standing: CLASSEE }),
    { kind: 'rated', rating: 1016, matches: 3 }
  );
});

test('une ligne à zéro partie est traitée comme non classée', () => {
  // La base ne devrait pas en produire, mais l'écran ne doit pas afficher
  // « 1000 · 0 partie », qui est la formulation la plus trompeuse possible.
  assert.deepEqual(
    ratingDisplay({
      gameCrc32: '8F24F886', watched: true,
      standing: { userId: 'alice', isAnonymous: false, rating: 1000, matches: 0 }
    }),
    { kind: 'unranked' }
  );
});

test('un invité prime sur tout le reste', () => {
  // Si une ligne d'invité portait une cote - ce que #61 rend impossible, mais
  // qu'un defaut futur pourrait produire - c'est « invité » qu'il faut dire.
  assert.deepEqual(
    ratingDisplay({
      gameCrc32: '8F24F886', watched: true,
      standing: { userId: 'guest', isAnonymous: true, rating: 1200, matches: 9 }
    }),
    { kind: 'guest' }
  );
});
