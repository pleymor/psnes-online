/**
 * Le mouvement du décor, sans état ni horloge.
 *
 * Chaque fonction est `t -> position`. Pas d'incrément par image : le temps
 * vient du runtime XR, et un compteur interne dériverait de lui à la première
 * image sautée - or un goomba qui dérive finit par sortir de sa plate-forme.
 *
 * Les tests portent sur les BORNES plutôt que sur des valeurs choisies. Une
 * valeur exacte à un instant donné ne dit rien d'utile ; « ne sort jamais de
 * son segment, quel que soit t » est la propriété qui compte.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { spriteFrame, patrol, drift, piranha } from '../../frontend/src/lib/vr/decor/motion.js';

test('la cadence d_image est celle demandée, pas celle du casque', () => {
  const o = { frames: 2, hz: 8 };
  assert.equal(spriteFrame(0, o), 0);
  assert.equal(spriteFrame(0.124, o), 0);
  assert.equal(spriteFrame(0.125, o), 1);
  assert.equal(spriteFrame(0.25, o), 0);
});

test('l_index d_image reste dans la plage pour tout t', () => {
  const o = { frames: 3, hz: 8 };
  for (const t of [-5, 0, 0.001, 7.3, 1e6]) {
    const frame = spriteFrame(t, o);
    assert.ok(Number.isInteger(frame), `${t} donne ${frame}`);
    assert.ok(frame >= 0 && frame < 3, `${t} donne ${frame}`);
  }
});

test('un goomba ne sort jamais de son segment', () => {
  const o = { from: -3, to: 3, speed: 1 };
  for (let t = 0; t < 60; t += 0.037) {
    const { at } = patrol(t, o);
    assert.ok(at >= o.from - 1e-9 && at <= o.to + 1e-9, `t=${t} donne ${at}`);
  }
});

test('un goomba part de sa borne basse et fait demi-tour à l_autre', () => {
  const o = { from: -3, to: 3, speed: 1 };
  assert.ok(Math.abs(patrol(0, o).at - -3) < 1e-9);
  assert.equal(patrol(0.5, o).facing, 1);
  // Six mètres à un mètre par seconde : le demi-tour est à six secondes.
  assert.ok(Math.abs(patrol(6, o).at - 3) < 1e-9);
  assert.equal(patrol(6.5, o).facing, -1);
  assert.ok(Math.abs(patrol(12, o).at - -3) < 1e-9);
});

test('un nuage revient au début au lieu de partir à l_infini', () => {
  const o = { start: 0, speed: 0.05, wrap: 10 };
  for (let t = 0; t < 1000; t += 7) {
    const at = drift(t, o);
    assert.ok(at >= 0 && at < o.wrap, `t=${t} donne ${at}`);
  }
});

test('la plante reste rentrée la plus grande partie du temps', () => {
  const o = { period: 6, outFor: 2.4, travel: 1.2, rise: 0.4 };
  assert.equal(piranha(0, o), 0);
  assert.equal(piranha(3, o), 0);
  assert.equal(piranha(5.9, o), 0);
  // Sortie complète au milieu de sa fenêtre.
  assert.ok(Math.abs(piranha(1.2, o) - 1.2) < 1e-9);
});

test('la plante ne dépasse jamais sa course', () => {
  const o = { period: 6, outFor: 2.4, travel: 1.2, rise: 0.4 };
  for (let t = 0; t < 60; t += 0.017) {
    const at = piranha(t, o);
    assert.ok(at >= 0 && at <= o.travel + 1e-9, `t=${t} donne ${at}`);
  }
});
