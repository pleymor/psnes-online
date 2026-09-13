/**
 * Les motifs de l'avatar, vérifiés sans casque ni GPU.
 *
 * `vr-decor-art.test.ts` balaie déjà `ALL_ART` pour les invariants communs
 * (grille rectangulaire, tout caractère dans la palette). Ce fichier-ci garde
 * ce qui est propre à l'avatar : qu'il soit bien INSCRIT au registre - la règle
 * que `art/index.ts` énonce : « un motif qui n'est pas ici n'est ni vérifié ni
 * rangé » - et que la face avant ne soit pas symétrique gauche-droite, faute de
 * quoi on ne verrait pas de quel côté un ami regarde.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ALL_ART } from '../../frontend/src/lib/vr/decor/art/index.js';
import { rasterise } from '../../frontend/src/lib/vr/decor/pixels.js';
import {
  AVATAR_FACE,
  AVATAR_SIDE,
  AVATAR_TOP,
  AVATAR_HAND
} from '../../frontend/src/lib/vr/lobby/avatar-art.js';

const EXPECTED = ['avatarFace', 'avatarSide', 'avatarTop', 'avatarHand'] as const;

test('les quatre motifs sont inscrits au registre', () => {
  for (const name of EXPECTED) {
    assert.ok(ALL_ART[name], `${name} absent de ALL_ART : ni vérifié ni rangé`);
  }
});

test('les faces de la tête sont carrées et de même taille', () => {
  for (const art of [AVATAR_FACE, AVATAR_SIDE, AVATAR_TOP]) {
    const raster = rasterise(art);
    assert.equal(raster.width, 16);
    assert.equal(raster.height, 16);
  }
});

test('la main tient dans la même grille', () => {
  const raster = rasterise(AVATAR_HAND);
  assert.equal(raster.width, 16);
  assert.equal(raster.height, 16);
});

test('aucun motif ne se rasterise en erreur', () => {
  for (const art of [AVATAR_FACE, AVATAR_SIDE, AVATAR_TOP, AVATAR_HAND]) {
    assert.doesNotThrow(() => rasterise(art));
  }
});

test("la face avant n'est pas symétrique : sinon on ne sait pas où l'ami regarde", () => {
  const raster = rasterise(AVATAR_FACE);
  let asymmetric = false;
  for (let y = 0; y < raster.height && !asymmetric; y++) {
    for (let x = 0; x < raster.width / 2; x++) {
      const left = (y * raster.width + x) * 4;
      const right = (y * raster.width + (raster.width - 1 - x)) * 4;
      for (let c = 0; c < 4; c++) {
        if (raster.data[left + c] !== raster.data[right + c]) {
          asymmetric = true;
          break;
        }
      }
      if (asymmetric) break;
    }
  }
  assert.ok(asymmetric, 'une tête symétrique ne dit pas de quel côté elle regarde');
});

test('la face avant est opaque partout : une tête ne doit pas être trouée', () => {
  const raster = rasterise(AVATAR_FACE);
  for (let i = 3; i < raster.data.length; i += 4) {
    assert.equal(raster.data[i], 255, `pixel transparent à l'octet ${i}`);
  }
});

test('la main a des pixels transparents : elle est découpée, pas carrée', () => {
  const raster = rasterise(AVATAR_HAND);
  let transparent = 0;
  for (let i = 3; i < raster.data.length; i += 4) {
    if (raster.data[i] === 0) transparent++;
  }
  assert.ok(transparent > 0, 'une main carrée serait un cube, pas une main');
});
