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

/*
 * Les refus.
 *
 * Pourquoi ce module jette au lieu de rendre un nombre douteux : ses divisions
 * portent sur des données écrites à la main dans `placement.ts`, et un zéro y
 * produit `Infinity` ou `NaN`. Un `NaN` dans une position three ne fait pas une
 * créature mal placée, il la fait DISPARAÎTRE - trois heures ont été passées ce
 * 2026-09-11 sur des boîtes invisibles pour une cause voisine. Le même choix
 * que `box.ts` et `pixels.ts`, pour la même raison : jeter en nommant le
 * coupable, plutôt que de laisser un objet manquant dans un casque à des
 * heures de sa cause.
 *
 * Le coût par image est nul en pratique : des comparaisons, aucune allocation.
 */

test('une cadence ou un nombre d_images impossible jette', () => {
  assert.throws(() => spriteFrame(0, { frames: 0, hz: 8 }), /images/);
  assert.throws(() => spriteFrame(0, { frames: 2.5, hz: 8 }), /images/);
  assert.throws(() => spriteFrame(0, { frames: 2, hz: 0 }), /cadence/);
});

test('un segment de patrouille vide ou une vitesse nulle jettent', () => {
  assert.throws(() => patrol(0, { from: -3, to: 3, speed: 0 }), /vitesse/);
  assert.throws(() => patrol(0, { from: -3, to: 3, speed: -1 }), /vitesse/);
  // Bornes égales ou inversées : le premier donne une période nulle, donc un
  // modulo par zéro ; le second fait marcher le goomba à reculons hors de son
  // segment, et c'est la faute de signe qu'une relecture ne voit pas.
  assert.throws(() => patrol(0, { from: 3, to: 3, speed: 1 }), /segment/);
  assert.throws(() => patrol(0, { from: 3, to: -3, speed: 1 }), /segment/);
});

test('une dérive sans longueur de boucle jette', () => {
  assert.throws(() => drift(0, { start: 0, speed: 1, wrap: 0 }), /boucle/);
});

test('une plante incohérente jette, et dit laquelle des quatre règles est en cause', () => {
  const sane = { period: 6, outFor: 2.4, travel: 1.1, rise: 0.4 };
  assert.throws(() => piranha(0, { ...sane, period: 0 }), /période/);
  assert.throws(() => piranha(0, { ...sane, rise: 0 }), /montée/);
  assert.throws(() => piranha(0, { ...sane, travel: 0 }), /course/);
  assert.throws(() => piranha(0, { ...sane, travel: -1 }), /course/);
  // Sortie plus longue que la période : la plante ne rentre jamais.
  assert.throws(() => piranha(0, { ...sane, outFor: 7 }), /fenêtre/);
  // Montée et descente qui ne tiennent pas dans la fenêtre : les deux rampes
  // se chevauchent et la tête saute au lieu de monter.
  assert.throws(() => piranha(0, { ...sane, outFor: 0.6 }), /rampes/);
});
