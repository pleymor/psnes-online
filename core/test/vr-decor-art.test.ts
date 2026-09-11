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
import { ART_PIXELS_PER_METRE } from '../../frontend/src/lib/vr/decor/composition.js';
import { COUNTER_BLOCK_WIDTH } from '../../frontend/src/lib/vr/layout.js';

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

test('la tuile posée au sol ne porte aucun contour', () => {
  /*
   * La leçon d'une session sous casque, le 2026-09-11.
   *
   * Le sol posait `GROUND_BRICK`, et le propriétaire l'a signalé d'un mot :
   * « c'est bizarre d'avoir des briques ». La cause n'était pas le goût mais
   * une confusion de projection - une brique est une ÉLÉVATION, vue de face,
   * alors qu'un sol se voit du dessus. Et le symptôme le plus visible tenait
   * au contour : carrelé, un bord sombre redessine une grille régulière tous
   * les mètres, que l'œil lit comme un artefact plutôt que comme une matière.
   *
   * Ce test ne peut pas juger qu'un dessin ressemble à de l'herbe. Il tient la
   * seule moitié qui soit mécanique, et c'est celle qui se re-brise le plus
   * facilement : pas de contour sur la surface où l'on marche.
   */
  const turf = ALL_ART.groundTurf;
  assert.ok(turf, 'groundTurf absent du registre');
  assert.ok(
    !Object.values(turf.palette).includes('outline'),
    'un contour fait réapparaître la grille au mètre une fois la tuile carrelée'
  );
});

test('un bloc de comptoir fait la largeur qu_annonce le plan, et deux mètres de haut', () => {
  /*
   * Les deux moitiés d'un même fait, tenues ensemble : `layout.ts` décide que
   * le comptoir est pavé de blocs d'un mètre, l'art doit s'y conformer, et
   * seize pixels valent un mètre.
   *
   * Les deux mètres de hauteur ne sont pas décoratifs. Le comptoir est ancré
   * aux panneaux et le sol ne l'est pas : sa base doit descendre sous
   * n'importe quel sol plausible, et le disque du sol enterre l'excédent.
   * Raccourcir ce motif fait réapparaître le bas du bloc en l'air pour les
   * joueurs les plus grands.
   */
  const brick = rasterise(ALL_ART.counterBrick);
  assert.equal(brick.width / ART_PIXELS_PER_METRE, COUNTER_BLOCK_WIDTH);
  assert.equal(brick.height / ART_PIXELS_PER_METRE, 2);
});

test('le dessus du comptoir ne porte aucun contour', () => {
  // La leçon du sol, appliquée à l'autre surface qu'on voit du dessus : un
  // bord sombre redessine une grille régulière une fois carrelé.
  assert.ok(
    !Object.values(ALL_ART.counterTop.palette).includes('outline'),
    'un contour ferait une grille sur le plateau'
  );
});

test('le flanc du comptoir est le même tracé, en plus sombre', () => {
  // Ce qui donne le volume sans un pixel de dessin supplémentaire. Si les deux
  // tracés divergent un jour, c'est que quelqu'un a redessiné au lieu de
  // recolorer.
  assert.deepEqual(ALL_ART.counterSide.rows, ALL_ART.counterBrick.rows);
  assert.notDeepEqual(ALL_ART.counterSide.palette, ALL_ART.counterBrick.palette);
});
