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
  createMemory,
  forget,
  reproject,
  stamp,
  SCROLL_WRAP,
  TRUST_THRESHOLD
} from '../../frontend/src/lib/vr/slot-memory.js';

/** Peint un pixel « déjà vu », sans passer par le masque. */
function remember(memory, x, y, rgb) {
  const at = y * memory.width + x;
  memory.data[at * 4] = rgb[0];
  memory.data[at * 4 + 1] = rgb[1];
  memory.data[at * 4 + 2] = rgb[2];
  memory.data[at * 4 + 3] = 255;
}

/** La couleur retenue à cet endroit, ou `null` si on n_y a jamais rien vu. */
function recall(memory, x, y) {
  const at = y * memory.width + x;
  if (!memory.data[at * 4 + 3]) return null;
  return [memory.data[at * 4], memory.data[at * 4 + 1], memory.data[at * 4 + 2]];
}

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

test('le recalage déplace ce qu_on a vu, du nombre de pixels demandé', () => {
  /*
   * Le test que tout le reste suppose. Un recalage qui se trompe de sens fait
   * glisser le fond à contresens du jeu - le symptôme exact de l'herbe du
   * lobby, qui a coûté deux corrections parce que personne ne l'avait épinglé.
   */
  const memory = createMemory(8, 8);
  remember(memory, 3, 3, [200, 10, 20]);

  reproject(memory, 2, 1);

  assert.deepEqual(recall(memory, 5, 4), [200, 10, 20], 'le pixel doit avoir suivi');
  assert.equal(recall(memory, 3, 3), null, 'et avoir quitté sa place');
});

test('ce qui sort du cadre est perdu, et ne revient pas par l_autre bord', () => {
  const memory = createMemory(8, 8);
  remember(memory, 7, 4, [1, 2, 3]);

  reproject(memory, 3, 0);

  for (let x = 0; x < 8; x++) {
    assert.equal(recall(memory, x, 4), null, `le pixel est réapparu en ${x}`);
  }
});

test('ce qui entre dans le cadre est marqué NON VU, et non peint en noir', () => {
  /*
   * La distinction qui fait tout ce module. Un pixel jamais vu servi comme du
   * noir serait exactement le défaut qu'on cherche à supprimer, mais avec
   * l'aplomb d'une vraie mesure - donc pire, parce qu'invisible au verdict.
   */
  const memory = createMemory(8, 8);
  for (let x = 0; x < 8; x++) remember(memory, x, 0, [90, 90, 90]);

  reproject(memory, 4, 0);

  assert.equal(recall(memory, 0, 0), null, 'le bord entrant ne doit rien prétendre');
  assert.deepEqual(recall(memory, 4, 0), [90, 90, 90], 'le reste doit avoir suivi');
});

test('un recalage nul ne touche à rien', () => {
  const memory = createMemory(4, 4);
  remember(memory, 1, 1, [5, 6, 7]);
  reproject(memory, 0, 0);
  assert.deepEqual(recall(memory, 1, 1), [5, 6, 7]);
});

test('on ne retient que les pixels que le calque a gagnés', () => {
  // Le masque est la seule source de vérité : un pixel gagné par un autre
  // calque n'appartient pas à cette mémoire, et l'y écrire reviendrait à
  // mémoriser le sprite qui BOUCHE le trou qu'on veut combler.
  const memory = createMemory(4, 2);
  const picture = new Uint8ClampedArray(4 * 2 * 4);
  const mask = new Uint8Array(4 * 2);
  for (let i = 0; i < 8; i++) {
    picture[i * 4] = 100 + i;
    picture[i * 4 + 1] = 0;
    picture[i * 4 + 2] = 0;
  }
  mask[0] = 3;
  mask[1] = 7;

  stamp(memory, picture, mask, 3, 4);

  assert.deepEqual(recall(memory, 0, 0), [100, 0, 0], 'le pixel du calque 3');
  assert.equal(recall(memory, 1, 0), null, 'celui du calque 7 ne nous regarde pas');
});

test('le verdict ne juge que les pixels déjà vus', () => {
  /*
   * Un pixel neuf ne prédit rien, donc il ne peut pas se tromper. Le compter
   * comme un accord diluerait le désaccord jusqu_à rendre le verdict toujours
   * favorable - c'est-à-dire inutile.
   */
  const memory = createMemory(4, 1);
  const picture = new Uint8ClampedArray(4 * 4);
  const mask = new Uint8Array(4).fill(1);

  const first = stamp(memory, picture, mask, 1, 4);
  assert.equal(first.compared, 0, 'la première image ne compare rien');

  const second = stamp(memory, picture, mask, 1, 4);
  assert.equal(second.compared, 4, 'la seconde compare tout');
  assert.equal(second.disagreements, 0, 'et la même image doit s_accorder');
});

test('une mémoire qui ment est comptée comme telle', () => {
  const memory = createMemory(4, 1);
  const mask = new Uint8Array(4).fill(1);
  const dark = new Uint8ClampedArray(4 * 4);
  const bright = new Uint8ClampedArray(4 * 4).fill(255);

  stamp(memory, dark, mask, 1, 4);
  const verdict = stamp(memory, bright, mask, 1, 4);

  assert.equal(verdict.compared, 4);
  assert.equal(verdict.disagreements, 4);
  assert.ok(!trustworthy(verdict.disagreements, verdict.compared));
});

test('un bit d_écart n_est pas un mensonge', () => {
  // Une couleur peut différer d'une unité après un aller-retour par une
  // texture. Jeter une mémoire parfaitement bonne pour ça ferait clignoter le
  // repli sans qu'aucune image ne soit fausse.
  const memory = createMemory(2, 1);
  const mask = new Uint8Array(2).fill(1);
  const a = new Uint8ClampedArray([40, 80, 120, 255, 40, 80, 120, 255]);
  const b = new Uint8ClampedArray([41, 79, 121, 255, 40, 80, 120, 255]);

  stamp(memory, a, mask, 1, 2);
  const verdict = stamp(memory, b, mask, 1, 2);

  assert.equal(verdict.disagreements, 0);
});

test('oublier efface ce qu_on savait sans casser la mémoire', () => {
  const memory = createMemory(4, 1);
  remember(memory, 2, 0, [9, 9, 9]);

  forget(memory);

  assert.equal(recall(memory, 2, 0), null);
  const mask = new Uint8Array(4).fill(1);
  const picture = new Uint8ClampedArray(4 * 4).fill(60);
  const verdict = stamp(memory, picture, mask, 1, 4);
  assert.equal(verdict.compared, 0, 'après un oubli, plus rien à comparer');
  assert.deepEqual(recall(memory, 0, 0), [60, 60, 60], 'mais on réapprend');
});

test('une mémoire peut être une VUE sur un tampon plus grand', () => {
  /*
   * Ce qui permet à `slot-fill.ts` de ranger toutes les mémoires dans un seul
   * atlas et de le téléverser d'un bloc. Sans ça, il faudrait recopier chaque
   * mémoire dans l'atlas à chaque image - le même travail, fait deux fois.
   */
  const atlas = new Uint8ClampedArray(2 * 4 * 1 * 4);
  const second = createMemory(4, 1, atlas.subarray(4 * 1 * 4));
  remember(second, 0, 0, [7, 8, 9]);

  assert.equal(atlas[4 * 1 * 4], 7, 'la vue doit écrire dans l_atlas');
  assert.equal(atlas[0], 0, 'et pas déborder sur la mémoire voisine');
});

test('un adossement trop court est refusé plutôt que débordé', () => {
  // Un débordement silencieux écrirait dans la mémoire du calque voisin, et le
  // symptôme serait un calque qui affiche des morceaux d'un autre - un défaut
  // qu'on chercherait n'importe où sauf ici.
  assert.throws(() => createMemory(4, 4, new Uint8ClampedArray(8)), /trop courte/);
});
