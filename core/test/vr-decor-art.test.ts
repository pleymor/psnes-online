/**
 * Les invariants de l'art, sur TOUT le registre.
 *
 * Ce test ne connaît aucun motif par son nom : il balaie `ALL_ART`. Ajouter un
 * tuyau au lot 3 le fait donc vérifier sans toucher ici - et un motif qu'on
 * oublierait d'inscrire au registre ne serait vérifié par rien, ce qui est la
 * seule façon de passer entre les mailles.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ALL_ART } from '../../frontend/src/lib/vr/decor/art/index.js';
import { rasterise } from '../../frontend/src/lib/vr/decor/pixels.js';

test('le registre n_est pas vide', () => {
  assert.ok(Object.keys(ALL_ART).length > 0);
});

test('tout motif du registre se rastérise sans jeter', () => {
  for (const [name, art] of Object.entries(ALL_ART)) {
    // `rasterise` porte déjà les refus : grille en dents de scie, caractère
    // hors palette, palette hors couleurs, motif vide. Les appeler ici, c'est
    // les appliquer à tout le registre d'un coup.
    assert.doesNotThrow(() => rasterise(art), `${name} ne se rastérise pas`);
  }
});

test('toute tuile de sol fait exactement un mètre, soit seize pixels d_art', () => {
  for (const [name, art] of Object.entries(ALL_ART)) {
    if (!name.startsWith('ground')) continue;
    const raster = rasterise(art);
    assert.equal(raster.width, 16, `${name} fait ${raster.width} de large`);
    assert.equal(raster.height, 16, `${name} fait ${raster.height} de haut`);
  }
});
