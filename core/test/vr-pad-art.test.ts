/**
 * La manette SNES dessinée sur la tablette.
 *
 * Elle porte sa propre géométrie et n'emprunte pas celle de
 * `SnesPad.svelte`, et ce n'est pas de la duplication par paresse : le pad du
 * DOM lie DOUZE boutons (la croix comprise) et celui-ci en lie HUIT, parce
 * qu'en VR la croix est sur les sticks et n'est pas assignable. Partager la
 * forme avec des sémantiques différentes demanderait un module paramétré sur
 * les noms de boutons, pour zéro gain de correction : la forme d'une manette
 * SNES est une réalité physique fixe, et le mapping a déjà sa source unique
 * dans `pad-map.ts`. Deux dessins du même objet, pas deux vérités.
 *
 * Ce qui se teste ici est donc ce qu'une capture d'écran ne montrerait pas :
 * que les huit régions existent, ne se chevauchent pas, tiennent dans leur
 * boîte, que la croix n'en produit aucune, et que le diamant est dans le bon
 * sens - se tromper là est invisible sur une image et évident manette en main.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  padRegions,
  BIND_SEQUENCE,
  nextInSequence,
  PAD_ART_ASPECT
} from '../../frontend/src/lib/vr/panels/pad-art.js';
import { VR_BUTTONS } from '../../frontend/src/lib/vr/pad-map.js';

const BOX = { x: 40, y: 100, w: 560, h: 560 / PAD_ART_ASPECT };

const byId = (id: string) => padRegions(BOX).find((r) => r.id === id);
const centre = (id: string) => {
  const r = byId(id);
  assert.ok(r, `${id} n a pas de region`);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
};

test('les huit boutons assignables ont chacun leur region, et rien d autre', () => {
  const ids = padRegions(BOX).map((r) => r.id).sort();
  assert.deepEqual(ids, VR_BUTTONS.map((b) => `bind:${b}`).sort());
});

test('la croix ne produit aucune region, parce qu elle est sur les sticks', () => {
  const ids = padRegions(BOX).map((r) => r.id);
  for (const dir of ['up', 'down', 'left', 'right']) {
    assert.ok(!ids.includes(`bind:${dir}`), `${dir} est offert alors qu il n est pas assignable`);
  }
});

/*
 * Le diamant, dans le bon sens.
 *
 * X en haut, B en bas, Y à gauche, A à droite. C'est la disposition d'une
 * manette SNES, et l'inverser produit un dessin parfaitement crédible sur
 * lequel chaque pression tombe sur le bouton d'en face.
 */
test('le diamant de face est dans le sens d une manette SNES', () => {
  const x = centre('bind:x');
  const b = centre('bind:b');
  const y = centre('bind:y');
  const a = centre('bind:a');

  assert.ok(x.y < b.y, 'X doit etre au-dessus de B');
  assert.ok(y.x < a.x, 'Y doit etre a gauche de A');
  // Et le diamant est un diamant : les deux axes se croisent au meme centre.
  assert.ok(Math.abs(x.x - b.x) < 1e-6, 'X et B doivent etre sur le meme axe vertical');
  assert.ok(Math.abs(y.y - a.y) < 1e-6, 'Y et A doivent etre sur le meme axe horizontal');
});

test('les gachettes sont au-dessus des boutons de face, et de part et d autre', () => {
  const l = centre('bind:l');
  const r = centre('bind:r');
  assert.ok(l.x < r.x, 'L doit etre a gauche de R');
  assert.ok(l.y < centre('bind:x').y, 'les gachettes sont sur le dessus de la manette');
});

test('select est a gauche de start, comme sur le plastique', () => {
  assert.ok(centre('bind:select').x < centre('bind:start').x);
});

test('aucune region ne chevauche une autre', () => {
  const regions = padRegions(BOX);
  for (const p of regions) {
    for (const q of regions) {
      if (p === q) continue;
      const apart =
        p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
      assert.ok(apart, `${p.id} chevauche ${q.id}, donc hit() en avalera un`);
    }
  }
});

test('toutes les regions tiennent dans la boite du dessin', () => {
  for (const r of padRegions(BOX)) {
    assert.ok(r.x >= BOX.x - 1e-9 && r.y >= BOX.y - 1e-9, `${r.id} sort par en haut a gauche`);
    assert.ok(r.x + r.w <= BOX.x + BOX.w + 1e-9, `${r.id} sort par la droite`);
    assert.ok(r.y + r.h <= BOX.y + BOX.h + 1e-9, `${r.id} sort par le bas`);
  }
});

test('la boite se deplace sans deformer le dessin', () => {
  const moved = padRegions({ ...BOX, x: BOX.x + 200, y: BOX.y + 50 });
  const base = padRegions(BOX);
  moved.forEach((r, i) => {
    assert.ok(Math.abs(r.x - (base[i].x + 200)) < 1e-9);
    assert.ok(Math.abs(r.y - (base[i].y + 50)) < 1e-9);
    assert.equal(r.w, base[i].w);
  });
});

/*
 * La séquence, et le hors-limites qui laisserait une capture ouverte.
 *
 * « Tout configurer » avance d'un bouton à chaque capture réussie. Le dernier
 * doit terminer plutôt que de rendre un index qui n'existe pas - sinon la
 * capture reste armée sur rien, et le joueur presse dans le vide sans que rien
 * ne le lui dise.
 */
test('la sequence couvre exactement les huit boutons, une fois chacun', () => {
  assert.deepEqual([...BIND_SEQUENCE].sort(), [...VR_BUTTONS].sort());
  assert.equal(new Set(BIND_SEQUENCE).size, BIND_SEQUENCE.length);
});

test('la sequence suit l ordre du dessin', () => {
  // Groupes de haut en bas : les gâchettes, puis le diamant, puis les
  // pastilles. Dans le diamant : haut, gauche, droite, bas.
  assert.deepEqual([...BIND_SEQUENCE], ['l', 'r', 'x', 'y', 'a', 'b', 'select', 'start']);
});

test('elle avance jusqu au dernier, puis termine', () => {
  for (let i = 0; i < BIND_SEQUENCE.length - 1; i++) {
    assert.equal(nextInSequence(i), i + 1);
  }
  assert.equal(nextInSequence(BIND_SEQUENCE.length - 1), null, 'le dernier bouton doit terminer');
});

test('un index hors limites termine au lieu de deborder', () => {
  assert.equal(nextInSequence(BIND_SEQUENCE.length), null);
  assert.equal(nextInSequence(999), null);
  assert.equal(nextInSequence(-1), 0, 'avant le debut, la sequence commence');
});

/*
 * La taille des cibles, qui est ce qu'un dessin coûte.
 *
 * Les huit lignes que ce dessin remplace faisaient 640 x 64 px sur un canvas
 * de 1024, soit 25 x 2,5 degrés dans le casque. Un bouton de face dessiné à sa
 * taille réaliste fait 1,7 degré et une pastille START/SELECT 0,9 de haut :
 * joli, et bien plus dur à viser avec un pointeur à 1,54 m.
 *
 * D'où des boîtes de clic découplées du tracé - la pastille reste fine, sa
 * cible ne l'est pas - et d'où ce test, qui borne le côté court de chaque
 * cible. Sans lui, la prochaine retouche esthétique rendrait deux boutons
 * inatteignables sans que rien ne rougisse.
 */
test('aucune cible n est plus fine que 40 unites de la boite de reference', () => {
  // 40 unités sur 520 de large : à 640 px de canvas et 25,6 px/degré, cela
  // fait environ 1,9 degré - comparable à une icône de téléphone à bout de
  // bras, ce qu'un pointeur laser atteint sans effort.
  const box = { x: 0, y: 0, w: 520, h: 244 };
  for (const r of padRegions(box)) {
    assert.ok(
      Math.min(r.w, r.h) >= 40,
      `${r.id} ne fait que ${Math.min(r.w, r.h).toFixed(0)} unites sur son cote court`
    );
  }
});

test('la boite de clic d une pastille est plus haute que la pastille dessinee', () => {
  // Le seul endroit où le découplage se voit : une pastille SNES est fine, et
  // sa cible ne doit pas l'être. Si les deux redevenaient égales, ce test
  // tombe avec le précédent.
  const box = { x: 0, y: 0, w: 520, h: 244 };
  const select = padRegions(box).find((r) => r.id === 'bind:select');
  assert.ok(select);
  assert.ok(select.h > 20, 'la pastille dessinee fait 20 unites de haut');
});
