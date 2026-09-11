/**
 * Grille de caractères -> RGBA.
 *
 * Aucune dépendance au DOM : `rasterise` rend un tableau d'octets, et c'est
 * `build.ts` qui en fait une `ImageData`. C'est ce qui permet de tenir cette
 * arithmétique responsable sous Bun, où il n'y a ni canvas ni GPU - la leçon
 * que `picture-filter.ts` a déjà payée dans ce dépôt.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { rasterise, TRANSPARENT } from '../../frontend/src/lib/vr/decor/pixels.js';

test('un motif de deux sur deux rend seize octets, ligne du haut d_abord', () => {
  const art = { palette: { s: 'sky', o: 'outline' }, rows: ['so', 'os'] } as const;
  const raster = rasterise(art);

  assert.equal(raster.width, 2);
  assert.equal(raster.height, 2);
  assert.equal(raster.data.length, 16);

  // #5c94fc = 92, 148, 252
  assert.deepEqual([...raster.data.slice(0, 4)], [92, 148, 252, 255]);
  assert.deepEqual([...raster.data.slice(4, 8)], [0, 0, 0, 255]);
  // deuxième ligne, inversée
  assert.deepEqual([...raster.data.slice(8, 12)], [0, 0, 0, 255]);
  assert.deepEqual([...raster.data.slice(12, 16)], [92, 148, 252, 255]);
});

test('le point est transparent et ne porte aucune couleur', () => {
  const raster = rasterise({ palette: { s: 'sky' }, rows: [`s${TRANSPARENT}`] });
  assert.deepEqual([...raster.data.slice(4, 8)], [0, 0, 0, 0]);
});

test('une grille en dents de scie est refusée en nommant la ligne', () => {
  assert.throws(
    () => rasterise({ palette: { s: 'sky' }, rows: ['ss', 's'] }),
    /ligne 1/
  );
});

test('un caractère absent de la palette est refusé en le nommant', () => {
  assert.throws(() => rasterise({ palette: { s: 'sky' }, rows: ['sx'] }), /'x'/);
});

test('une palette qui pointe hors des couleurs est refusée', () => {
  assert.throws(
    () => rasterise({ palette: { s: 'mauve' as never }, rows: ['s'] }),
    /mauve/
  );
});

test('une grille vide est refusée plutôt que rendue en zéro sur zéro', () => {
  assert.throws(() => rasterise({ palette: {}, rows: [] }), /vide/);
});
