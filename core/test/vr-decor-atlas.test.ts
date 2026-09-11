/**
 * Tout l'art dans une seule texture, et les UV pour y piocher.
 *
 * Le rangement est pur, donc vérifiable : rien ne se chevauche, rien ne
 * déborde, et deux exécutions donnent le même plan. Un chevauchement se
 * verrait dans le casque comme un tuyau portant un morceau de goomba, ce qui
 * n'accuserait jamais le rangement.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { packAtlas, uvOf } from '../../frontend/src/lib/vr/decor/atlas.js';
import { ALL_ART } from '../../frontend/src/lib/vr/decor/art/index.js';
import { rasterise } from '../../frontend/src/lib/vr/decor/pixels.js';

test('chaque motif obtient un rectangle à sa taille', () => {
  const atlas = packAtlas(ALL_ART);
  for (const [name, art] of Object.entries(ALL_ART)) {
    const raster = rasterise(art);
    const rect = atlas.rects[name];
    assert.ok(rect, `${name} n'a pas de place`);
    assert.equal(rect.width, raster.width);
    assert.equal(rect.height, raster.height);
  }
});

test('aucun rectangle n_en chevauche un autre', () => {
  const atlas = packAtlas(ALL_ART);
  const rects = Object.entries(atlas.rects);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [nameA, a] = rects[i];
      const [nameB, b] = rects[j];
      const apart =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      assert.ok(apart, `${nameA} chevauche ${nameB}`);
    }
  }
});

test('aucun rectangle ne déborde de la texture', () => {
  const atlas = packAtlas(ALL_ART);
  for (const [name, rect] of Object.entries(atlas.rects)) {
    assert.ok(rect.x >= 0 && rect.y >= 0, `${name} sort par le haut ou la gauche`);
    assert.ok(rect.x + rect.width <= atlas.width, `${name} sort à droite`);
    assert.ok(rect.y + rect.height <= atlas.height, `${name} sort en bas`);
  }
});

test('la texture est carrée et de côté une puissance de deux', () => {
  const atlas = packAtlas(ALL_ART);
  assert.equal(atlas.width, atlas.height);
  assert.equal(atlas.width & (atlas.width - 1), 0, `${atlas.width} n'est pas une puissance de deux`);
});

test('le rangement est déterministe', () => {
  assert.deepEqual(packAtlas(ALL_ART), packAtlas(ALL_ART));
});

test('les uv sont retournées, parce que three retourne la texture', () => {
  // `flipY` vaut true par défaut sur une CanvasTexture : la ligne du HAUT du
  // canvas devient v = 1. Un motif rangé tout en haut doit donc sortir avec
  // v1 = 1, et non v0 = 0.
  const atlas = { width: 64, height: 64, rects: { a: { x: 0, y: 0, width: 16, height: 16 } } };
  const uv = uvOf(atlas, 'a');
  assert.equal(uv.u0, 0);
  assert.equal(uv.u1, 16 / 64);
  assert.equal(uv.v1, 1);
  assert.equal(uv.v0, 1 - 16 / 64);
});

test('un motif inconnu jette plutôt que de rendre des uv nulles', () => {
  const atlas = packAtlas(ALL_ART);
  assert.throws(() => uvOf(atlas, 'licorne'), /licorne/);
});
