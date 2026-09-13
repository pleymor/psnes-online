/**
 * La règle demandée : un ami trop près s'efface pour ne pas gêner.
 *
 * Elle remplace l'allocateur de places de départ qu'on n'a pas voulu : tout le
 * monde entre au même point du repère du décor, donc tout le monde se
 * chevauche pendant quelques secondes, et c'est cette règle qui fait que ça ne
 * se voit pas. Elle sert aussi au cas qui compte vraiment - un ami qui vient
 * se coller à vous.
 *
 * Le test du seuil bas garde `visible: false` et non `opacity: 0` : un objet
 * transparent invisible coûte quand même son tri, et ce dépôt a déjà payé un
 * basculement d'ordre de rendu sur une surface transparente.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  presenceFor,
  FADE_NEAR,
  FADE_FULL
} from '../../frontend/src/lib/vr/lobby/proximity.js';
import type { Pose } from '../../frontend/src/lib/vr/lobby/roster.js';

function at(x: number, y = 0, z = 0): Pose {
  return [x, y, z, 0, 0, 0, 1];
}

test('un ami lointain est entièrement solide', () => {
  const p = presenceFor(at(0), at(5));
  assert.equal(p.visible, true);
  assert.equal(p.opacity, 1);
});

test('un ami juste au-delà du seuil haut est solide', () => {
  const p = presenceFor(at(0), at(FADE_FULL + 0.01));
  assert.equal(p.visible, true);
  assert.ok(Math.abs(p.opacity - 1) < 1e-6, `opacité=${p.opacity}`);
});

test('un ami sous le seuil bas est absent, pas transparent', () => {
  const p = presenceFor(at(0), at(0.2));
  assert.equal(p.visible, false, 'un objet transparent invisible coûte encore son tri');
});

test('deux joueurs exactement superposés — le cas du départ — ne se gênent pas', () => {
  const p = presenceFor(at(0), at(0));
  assert.equal(p.visible, false);
});

test("à mi-chemin entre les deux seuils, l'opacité est à la moitié", () => {
  const middle = (FADE_NEAR + FADE_FULL) / 2;
  const p = presenceFor(at(0), at(middle));
  assert.equal(p.visible, true);
  assert.ok(Math.abs(p.opacity - 0.5) < 1e-6, `opacité=${p.opacity}`);
});

test("l'opacité croît avec la distance, sans marche d'escalier", () => {
  let previous = -1;
  for (let d = FADE_NEAR; d <= FADE_FULL; d += 0.05) {
    const p = presenceFor(at(0), at(d));
    assert.ok(p.opacity >= previous, `l'opacité a reculé à d=${d}`);
    previous = p.opacity;
  }
});

test('la distance se mesure en trois dimensions, pas seulement au sol', () => {
  // Un ami debout sur un tuyau, juste au-dessus : loin en hauteur, au même
  // point au sol. Mesurer à plat le ferait disparaître sans raison.
  const p = presenceFor(at(0, 0, 0), at(0, 2, 0));
  assert.equal(p.visible, true, "deux mètres au-dessus, c'est loin");
});

test("l'orientation n'entre pas dans le calcul", () => {
  const turned: Pose = [3, 0, 0, 0, 1, 0, 0];
  const straight: Pose = [3, 0, 0, 0, 0, 0, 1];
  assert.deepEqual(presenceFor(at(0), turned), presenceFor(at(0), straight));
});

/*
 * Le repli quand je n'ai pas encore ma propre pose.
 *
 * Il vivait dans la boucle de dessin, donc hors de portée de tout test :
 * `avatars.ts` importe three, que Bun ne sait pas exécuter. Une politique de
 * proximité invérifiable est exactement ce que ce module existe pour éviter.
 */
test("sans ma propre pose, un ami est montré solide plutôt que masqué", () => {
  const p = presenceFor(null, at(0));
  assert.equal(p.visible, true, "faire disparaître le lobby serait le pire repli");
  assert.equal(p.opacity, 1);
});

test("sans ma propre pose, même un ami superposé reste visible", () => {
  // Le cas qui décide : à zéro mètre, la règle de distance dirait « absent ».
  // Mais l'effacement existe pour qu'un ami ne me gêne PAS, et sans ma pose il
  // n'y a aucune gêne à constater - seulement une distance inconnue.
  assert.equal(presenceFor(null, at(0, 0, 0)).visible, true);
});
