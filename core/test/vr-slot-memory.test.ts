/**
 * Recaler ce qu'un calque a déjà montré.
 *
 * Ces tests portent sur les deux choses que ce module peut se tromper en
 * silence : le SENS du décalage, et la confiance qu'on accorde à une mémoire
 * dont la prédiction est fausse. Le premier a coûté cinq erreurs à ce dépôt
 * dans d'autres modules ; le second est ce qui distingue « approximatif » de
 * « faux sans le savoir ».
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  shiftFor,
  scrollDelta,
  trustworthy,
  inside,
  SCROLL_WRAP,
  TRUST_THRESHOLD
} from '../../frontend/src/lib/vr/slot-memory.js';

test('un défilement nul ne décale rien', () => {
  assert.deepEqual(shiftFor({ h: 40, v: 7 }, { h: 40, v: 7 }), { dx: 0, dy: 0 });
});

test('la mémoire se décale à l_OPPOSÉ du défilement', () => {
  /*
   * Le sens, énoncé du point de vue du décor et non de l'axe : quand la caméra
   * avance vers la droite, ce qui était au pixel 100 se retrouve plus à
   * gauche. Une mémoire décalée dans le sens du défilement ferait glisser le
   * fond deux fois plus vite que le jeu - le même symptôme que l'herbe du
   * lobby, pour la même raison.
   */
  assert.deepEqual(shiftFor({ h: 0, v: 0 }, { h: 4, v: 0 }), { dx: -4, dy: 0 });
  assert.deepEqual(shiftFor({ h: 0, v: 0 }, { h: 0, v: 3 }), { dx: 0, dy: -3 });
  assert.deepEqual(shiftFor({ h: 10, v: 10 }, { h: 6, v: 8 }), { dx: 4, dy: 2 });
});

test('un demi-pixel s_arrondit, il ne s_interpole pas', () => {
  // Interpoler étalerait la mémoire un peu plus à chaque image, jusqu'à la
  // rendre floue - un défaut qui s'installe sans jamais se déclarer.
  const { dx } = shiftFor({ h: 0, v: 0 }, { h: 2.5, v: 0 });
  assert.ok(Number.isInteger(dx), `${dx} n_est pas entier`);
});

test('le passage par zéro n_est pas un saut de mille pixels', () => {
  /*
   * Le défilement boucle à 1024. Sans ce soin, un calque qui repasse de 1023 à
   * 0 produirait un delta énorme, la mémoire serait jetée, et le trou noir
   * reviendrait une image sur mille - un défaut intermittent, donc le pire.
   */
  assert.equal(scrollDelta(1023, 1), 2);
  assert.equal(scrollDelta(1, 1023), -2);
  assert.equal(scrollDelta(0, 5), 5);
  assert.equal(scrollDelta(SCROLL_WRAP - 5, SCROLL_WRAP - 1), 4);
});

test('le delta le plus court est toujours choisi', () => {
  // Un demi-tour exact est le seul cas ambigu, et il ne doit pas exploser.
  assert.ok(Math.abs(scrollDelta(0, SCROLL_WRAP / 2)) <= SCROLL_WRAP / 2);
  for (const [a, b] of [[100, 900], [900, 100], [0, 512], [512, 0]]) {
    assert.ok(Math.abs(scrollDelta(a, b)) <= SCROLL_WRAP / 2, `${a}->${b}`);
  }
});

test('une mémoire qui s_accorde est gardée, une qui diverge est jetée', () => {
  const compared = 1000;
  assert.ok(trustworthy(0, compared), 'un accord parfait doit être cru');
  assert.ok(trustworthy(TRUST_THRESHOLD * compared, compared), 'le seuil est inclusif');
  assert.ok(!trustworthy(TRUST_THRESHOLD * compared + 1, compared), 'au-delà, on jette');
  assert.ok(!trustworthy(compared, compared), 'un désaccord total doit être jeté');
});

test('sans rien à comparer, on ne croit pas', () => {
  /*
   * Le cas de la première image, et celui d'un calque qui n'a rien gagné cette
   * fois-ci. Ne rien pouvoir vérifier n'est pas une raison de faire confiance -
   * c'en est une de se taire.
   */
  assert.ok(!trustworthy(0, 0));
});

test('ce qui sort du cadre ne revient pas par l_autre bord', () => {
  // La mémoire d'un calque n'est pas un monde torique : un décor qui
  // reviendrait par la gauche après être sorti par la droite serait plus
  // troublant qu'un trou.
  assert.ok(inside(0, 0, 256, 224));
  assert.ok(inside(255, 223, 256, 224));
  assert.ok(!inside(-1, 0, 256, 224));
  assert.ok(!inside(256, 0, 256, 224));
  assert.ok(!inside(0, 224, 256, 224));
});
