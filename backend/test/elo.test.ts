/**
 * La formule, et rien d'autre.
 *
 * Pure et sans base, pour la raison que l'en-tête de `saves/import-plan.ts`
 * énonce : rien ici ne peut piloter un handler dans un test, donc une règle
 * écrite dans une route est une règle que personne ne peut prouver.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, INITIAL_RATING, K_FACTOR } from '../src/ratings/elo.js';

test('deux inconnus : le vainqueur prend la moitié du facteur K', () => {
  const standings = fold([{ p1UserId: 'a', p2UserId: 'b', winner: 1 }]);
  assert.equal(standings.get('a')!.rating, INITIAL_RATING + K_FACTOR / 2);
  assert.equal(standings.get('b')!.rating, INITIAL_RATING - K_FACTOR / 2);
});

test('un double KO entre égaux ne bouge rien, mais compte une partie', () => {
  const standings = fold([{ p1UserId: 'a', p2UserId: 'b', winner: 0 }]);
  assert.equal(standings.get('a')!.rating, INITIAL_RATING);
  assert.equal(standings.get('b')!.rating, INITIAL_RATING);
  assert.equal(standings.get('a')!.matches, 1);
  assert.equal(standings.get('b')!.matches, 1);
});

test('la somme des cotes est exactement conservée', () => {
  // Le delta est arrondi une fois puis appliqué symétriquement : ce test est
  // ce qui interdit de l'arrondir deux fois, ce qui ferait fuir des points.
  const standings = fold([
    { p1UserId: 'a', p2UserId: 'b', winner: 1 },
    { p1UserId: 'a', p2UserId: 'b', winner: 1 },
    { p1UserId: 'b', p2UserId: 'a', winner: 1 },
    { p1UserId: 'a', p2UserId: 'c', winner: 2 }
  ]);
  const total = [...standings.values()].reduce((sum, s) => sum + s.rating, 0);
  assert.equal(total, INITIAL_RATING * 3);
});

test('battre plus faible que soi rapporte moins', () => {
  const strong = fold([
    { p1UserId: 'a', p2UserId: 'b', winner: 1 },
    { p1UserId: 'a', p2UserId: 'b', winner: 1 },
    { p1UserId: 'a', p2UserId: 'b', winner: 1 }
  ]);
  const gains: number[] = [];
  let previous = INITIAL_RATING;
  for (let n = 1; n <= 3; n++) {
    const upTo = fold(
      Array.from({ length: n }, () => ({ p1UserId: 'a', p2UserId: 'b', winner: 1 as const }))
    );
    gains.push(upTo.get('a')!.rating - previous);
    previous = upTo.get('a')!.rating;
  }
  assert.ok(gains[0] > gains[1], 'le premier gain est le plus gros');
  assert.ok(gains[1] >= gains[2]);
  assert.ok(strong.get('a')!.rating > INITIAL_RATING);
});

test('l\'ordre des parties change le résultat', () => {
  // Elo est un pliage séquentiel. C'est la raison pour laquelle le recalcul
  // relit les parties dans l'ordre plutôt que d'appliquer un delta à l'arrivée.
  const forward = fold([
    { p1UserId: 'a', p2UserId: 'b', winner: 1 },
    { p1UserId: 'a', p2UserId: 'c', winner: 1 }
  ]);
  const backward = fold([
    { p1UserId: 'a', p2UserId: 'c', winner: 1 },
    { p1UserId: 'a', p2UserId: 'b', winner: 1 }
  ]);
  assert.notDeepEqual(
    [forward.get('b')!.rating, forward.get('c')!.rating],
    [backward.get('b')!.rating, backward.get('c')!.rating]
  );
});

test('une liste vide ne classe personne', () => {
  assert.equal(fold([]).size, 0);
});
