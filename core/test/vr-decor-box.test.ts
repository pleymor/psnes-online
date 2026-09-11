/**
 * La boîte qui donne du volume à un dessin plat.
 *
 * Pourquoi une géométrie à la main plutôt qu'une `BoxGeometry` de three : il
 * faut des uv DIFFÉRENTES par face - la façade porte le dessin, les côtés une
 * bande assombrie - et `BoxGeometry` en impose un jeu unique. C'est le même
 * raisonnement que `screen-geometry.ts`, qui génère son maillage pour la même
 * raison, et avec le même bénéfice : tout est une fonction pure.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { boxGeometry } from '../../frontend/src/lib/vr/decor/box.js';

const UV = { u0: 0, v0: 0, u1: 0.5, v1: 0.5 };
const SPEC = { width: 2, height: 1, depth: 0.5, front: UV, side: UV, top: UV };

test('cinq faces font vingt sommets et trente indices', () => {
  const box = boxGeometry(SPEC);
  assert.equal(box.positions.length, 20 * 3);
  assert.equal(box.uvs.length, 20 * 2);
  assert.equal(box.indices.length, 5 * 6);
});

test('aucun sommet ne sort de la boîte annoncée', () => {
  const box = boxGeometry(SPEC);
  for (let i = 0; i < box.positions.length; i += 3) {
    assert.ok(Math.abs(box.positions[i]) <= SPEC.width / 2 + 1e-9, 'x déborde');
    assert.ok(Math.abs(box.positions[i + 1]) <= SPEC.height / 2 + 1e-9, 'y déborde');
    assert.ok(Math.abs(box.positions[i + 2]) <= SPEC.depth / 2 + 1e-9, 'z déborde');
  }
});

test('la boîte est centrée : chaque extrémité est atteinte', () => {
  const box = boxGeometry(SPEC);
  const xs: number[] = [];
  for (let i = 0; i < box.positions.length; i += 3) xs.push(box.positions[i]);
  assert.equal(Math.min(...xs), -SPEC.width / 2);
  assert.equal(Math.max(...xs), SPEC.width / 2);
});

test('il n_y a pas de face dessous', () => {
  // Toutes les faces horizontales sont en HAUT. Une face du dessous serait
  // invisible depuis le sol et doublerait la surface à remplir pour rien.
  const box = boxGeometry(SPEC);
  const bottoms: number[] = [];
  for (let i = 0; i < box.positions.length; i += 3) {
    if (box.positions[i + 1] === -SPEC.height / 2) bottoms.push(i);
  }
  // Les quatre faces verticales touchent le bas, mais aucune n'y est plane :
  // huit sommets au total, pas douze.
  assert.equal(bottoms.length, 8);
});

test('la façade porte les uv de la façade', () => {
  // Des fractions dyadiques : exactement représentables en float32, pour que
  // la comparaison stricte contre des littéraux ne trébuche pas sur un
  // arrondi (positions et uv sont des Float32Array).
  const front = { u0: 0.125, v0: 0.25, u1: 0.375, v1: 0.5 };
  const box = boxGeometry({ ...SPEC, front });
  // La façade est la première face émise : ses quatre sommets ouvrent le
  // tableau des uv.
  assert.deepEqual([...box.uvs.slice(0, 8)], [
    front.u0, front.v1, front.u1, front.v1, front.u0, front.v0, front.u1, front.v0
  ]);
});

test('une dimension nulle est refusée', () => {
  assert.throws(() => boxGeometry({ ...SPEC, depth: 0 }), /profondeur/);
});
