/**
 * À quelle hauteur poser le sol, et pourquoi tout échec y répond pareil.
 *
 * Le port existe pour la raison que tout le code d'appareil de ce dépôt
 * donne : pour que la décision soit testable sans casque, sans WebXR et sans
 * espace de référence.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { measureFloor } from '../../frontend/src/lib/vr/decor/floor.js';
import { FLOOR_FALLBACK } from '../../frontend/src/lib/vr/decor/composition.js';

const SPACE = {};

test('la pose mesurée donne la hauteur, en positif sous l_œil', () => {
  const height = measureFloor({
    floorSpace: () => SPACE,
    poseOf: () => ({ y: -1.42 })
  });
  assert.equal(height, 1.42);
});

test('un casque qui refuse local-floor répond tout de suite, par le repli', () => {
  // Pas `null` : il n'y a rien à attendre. Redemander image après image un
  // espace que le casque a refusé ne le ferait jamais apparaître, et le décor
  // ne serait jamais construit.
  const height = measureFloor({ floorSpace: () => null, poseOf: () => ({ y: -1.42 }) });
  assert.equal(height, FLOOR_FALLBACK);
});

test('un suivi pas encore prêt demande qu_on rappelle, sans se replier', () => {
  // La distinction est tout l'intérêt de cette fonction. Se replier ici
  // figerait 1,20 m à la première image d'une session dont le suivi met trois
  // images à démarrer - et le repli deviendrait le cas NORMAL.
  const height = measureFloor({ floorSpace: () => SPACE, poseOf: () => null });
  assert.equal(height, null);
});

test('un sol au-dessus de l_œil est refusé plutôt que cru', () => {
  // Le signe inversé est l'erreur la plus plausible de cette plomberie, et
  // elle est invisible : le sol serait au plafond, ce qui se lit comme un bug
  // de rendu et non comme un signe.
  const height = measureFloor({ floorSpace: () => SPACE, poseOf: () => ({ y: 1.42 }) });
  assert.equal(height, FLOOR_FALLBACK);
});

test('un sol à trois mètres sous l_œil est refusé', () => {
  const height = measureFloor({ floorSpace: () => SPACE, poseOf: () => ({ y: -3 }) });
  assert.equal(height, FLOOR_FALLBACK);
});

test('un port qui jette ne barre pas la route', () => {
  const height = measureFloor({
    floorSpace: () => {
      throw new Error('boom');
    },
    poseOf: () => null
  });
  assert.equal(height, FLOOR_FALLBACK);
});
