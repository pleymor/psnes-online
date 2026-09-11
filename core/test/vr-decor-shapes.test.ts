/**
 * Le générateur de silhouettes, et pourquoi il y en a un seul.
 *
 * Dans SMB, le buisson, la colline et le nuage partagent la même forme : une
 * rangée de lobes. Un générateur les rend tous les trois, ce qui remplace des
 * centaines de lignes de grille littérale par des nombres qu'on peut vérifier.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mound, banded } from '../../frontend/src/lib/vr/decor/art/shapes.js';
import { rasterise } from '../../frontend/src/lib/vr/decor/pixels.js';

const PALETTE = { body: 'hill', shade: 'hillDark', edge: 'outline' } as const;

test('la largeur est la somme des diamètres, la hauteur le plus grand rayon', () => {
  const art = mound([8, 12, 8], PALETTE);
  const raster = rasterise(art);
  assert.equal(raster.width, 2 * (8 + 12 + 8));
  assert.equal(raster.height, 12);
});

test('des lobes symétriques donnent une silhouette symétrique', () => {
  // Le miroir est la seule propriété qu'on puisse vérifier sans redessiner la
  // forme à la main - et une erreur d'un pixel dans le centrage des lobes la
  // casse, alors qu'elle passerait inaperçue à l'œil.
  const art = mound([8, 12, 8], PALETTE);
  for (const row of art.rows) {
    assert.equal(row, [...row].reverse().join(''), `ligne non miroir : ${row}`);
  }
});

test('la grille reste rectangulaire et se rastérise', () => {
  const art = mound([6, 10, 14, 10, 6], PALETTE);
  const width = art.rows[0].length;
  for (const row of art.rows) assert.equal(row.length, width);
  assert.doesNotThrow(() => rasterise(art));
});

test('le sommet de chaque colonne pleine porte le contour', () => {
  const art = mound([8], PALETTE);
  for (let x = 0; x < art.rows[0].length; x++) {
    const firstFilled = art.rows.findIndex((row) => row[x] !== '.');
    if (firstFilled === -1) continue;
    assert.equal(art.rows[firstFilled][x], 'e', `colonne ${x} sans contour`);
  }
});

test('un lobe de rayon nul est refusé plutôt que rendu vide', () => {
  assert.throws(() => mound([0], PALETTE), /rayon/);
});

test('les bandes verticales couvrent toute la largeur sans trou', () => {
  const art = banded(8, 4, [
    { to: 1, colour: 'outline' },
    { to: 3, colour: 'pipeHi' },
    { to: 7, colour: 'pipe' },
    { to: 8, colour: 'outline' }
  ]);
  const raster = rasterise(art);
  assert.equal(raster.width, 8);
  assert.equal(raster.height, 4);
  // Aucun pixel transparent : une bande manquante laisserait un trou vertical
  // dans un tuyau, ce qui se voit mais seulement dans un casque.
  for (let i = 3; i < raster.data.length; i += 4) assert.equal(raster.data[i], 255);
});

test('des bandes qui ne finissent pas à la largeur sont refusées', () => {
  assert.throws(
    () => banded(8, 4, [{ to: 6, colour: 'pipe' }]),
    /couvre 6 colonnes sur 8/
  );
});

test('toutes les lignes d_une bande verticale sont identiques', () => {
  const art = banded(6, 3, [{ to: 6, colour: 'pipe' }]);
  assert.equal(new Set(art.rows).size, 1);
});
