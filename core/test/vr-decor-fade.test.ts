/**
 * L'opacité du rideau au fil du fondu.
 *
 * Pur et minuscule, mais pas gratuit : les deux sens ont des extrémités
 * inverses, et se tromper de sens donne un monde qui apparaît d'un coup au
 * lancement d'un jeu - exactement l'à-coup de luminance que le fondu existe
 * pour éviter.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { curtain, elapsedFor } from '../../frontend/src/lib/vr/decor/fade.js';
import { FADE_SECONDS } from '../../frontend/src/lib/vr/decor/composition.js';

test('vers le noir : transparent au départ, opaque à l_arrivée', () => {
  assert.deepEqual(curtain(0, 'dark'), { opacity: 0, done: false });
  assert.deepEqual(curtain(FADE_SECONDS, 'dark'), { opacity: 1, done: true });
});

test('vers le décor : opaque au départ, transparent à l_arrivée', () => {
  assert.deepEqual(curtain(0, 'decor'), { opacity: 1, done: false });
  assert.deepEqual(curtain(FADE_SECONDS, 'decor'), { opacity: 0, done: true });
});

test('à mi-course, les deux sens se croisent à la moitié', () => {
  const half = FADE_SECONDS / 2;
  assert.ok(Math.abs(curtain(half, 'dark').opacity - 0.5) < 1e-9);
  assert.ok(Math.abs(curtain(half, 'decor').opacity - 0.5) < 1e-9);
});

test('un temps négatif est ramené au départ plutôt que de dépasser', () => {
  // Une horloge qui recule d'une image arrive : `t` vient du runtime XR.
  assert.deepEqual(curtain(-1, 'dark'), { opacity: 0, done: false });
});

test('au-delà de la durée, le fondu reste terminé', () => {
  assert.deepEqual(curtain(FADE_SECONDS * 10, 'dark'), { opacity: 1, done: true });
  assert.deepEqual(curtain(FADE_SECONDS * 10, 'decor'), { opacity: 0, done: true });
});

test('l_instant d_une opacité est l_inverse exact de la courbe', () => {
  // La propriété qui compte : repartir de `elapsedFor` redonne l'opacité
  // qu'on avait, donc le revirement est continu.
  for (const opacity of [0, 0.25, 0.5, 0.75, 1]) {
    for (const to of ['dark', 'decor'] as const) {
      const back = curtain(elapsedFor(opacity, to), to).opacity;
      assert.ok(Math.abs(back - opacity) < 1e-9, `${to} à ${opacity} redonne ${back}`);
    }
  }
});

test('les extrémités tombent aux bons instants', () => {
  assert.equal(elapsedFor(0, 'dark'), 0);
  assert.equal(elapsedFor(1, 'dark'), FADE_SECONDS);
  assert.equal(elapsedFor(1, 'decor'), 0);
  assert.equal(elapsedFor(0, 'decor'), FADE_SECONDS);
});

test('une opacité hors bornes est ramenée plutôt que propagée', () => {
  assert.equal(elapsedFor(-1, 'dark'), 0);
  assert.equal(elapsedFor(2, 'dark'), FADE_SECONDS);
});
