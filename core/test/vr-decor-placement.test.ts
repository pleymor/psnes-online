/**
 * Les placements du relief : les règles que la relecture n'attrape pas.
 *
 * Le test ne juge pas la composition - c'est affaire de goût et de casque. Il
 * tient les quatre invariants dont la violation est invisible depuis un
 * terminal et coûteuse dans un casque.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { scenery, props } from '../../frontend/src/lib/vr/decor/placement.js';
import {
  DECOR_NEAR,
  SKY_RADIUS,
  ART_PIXELS_PER_METRE,
  screenShadow
} from '../../frontend/src/lib/vr/decor/composition.js';
import { ALL_ART } from '../../frontend/src/lib/vr/decor/art/index.js';

test('aucun élément ne vient devant le rideau ni derrière le ciel', () => {
  for (const prop of scenery()) {
    assert.ok(prop.radius >= DECOR_NEAR, `${prop.art} à ${prop.radius} m est trop près`);
    assert.ok(prop.radius <= SKY_RADIUS, `${prop.art} à ${prop.radius} m dépasse le ciel`);
  }
});

test('tout élément désigne un motif qui existe', () => {
  for (const prop of scenery()) {
    assert.ok(ALL_ART[prop.art], `motif inconnu : ${prop.art}`);
  }
});

test('le relief fait vraiment le tour, pas seulement le devant', () => {
  // Le demandeur a choisi 360 degrés. Un décor qui ne couvre que l'avant est
  // la régression silencieuse la plus facile à commettre ici : on compose en
  // regardant droit devant, et on ne se retourne jamais depuis un terminal.
  const quadrants = new Set(
    scenery().map((prop) => Math.floor((((prop.azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)))
  );
  assert.equal(quadrants.size, 4, `quadrants occupés : ${[...quadrants]}`);
});

test('les collines sont fixes et les nuages des billboards', () => {
  // La règle de la spec §6, et elle a une raison dans chaque sens : une
  // colline à vingt mètres qui pivoterait perdrait sa silhouette franche, un
  // nuage fixe montrerait sa tranche.
  for (const prop of scenery()) {
    if (prop.art.startsWith('hill')) assert.equal(prop.facing, 'fixed', prop.art);
    if (prop.art === 'cloud') assert.equal(prop.facing, 'billboard', prop.art);
  }
});

test('les nuages flottent et le reste est posé', () => {
  for (const prop of scenery()) {
    if (prop.art === 'cloud') assert.ok(prop.standing > 2, 'un nuage au sol');
    else assert.equal(prop.standing, 0, `${prop.art} flotte`);
  }
});

test('la composition est déterministe', () => {
  assert.deepEqual(scenery(), scenery());
});

test('aucun objet proche ne vient devant le rideau', () => {
  for (const prop of props()) {
    assert.ok(prop.radius >= DECOR_NEAR, `${prop.front} à ${prop.radius} m`);
  }
});

test('tout objet proche désigne trois motifs qui existent', () => {
  for (const prop of props()) {
    for (const art of [prop.front, prop.side, prop.top]) {
      assert.ok(ALL_ART[art], `motif inconnu : ${art}`);
    }
  }
});

test('les objets proches restent dans la zone où la stéréo voit le volume', () => {
  // La spec §6 : la boîte se justifie sous douze mètres. Plus loin, elle coûte
  // quatre faces pour un volume que personne ne perçoit, et il faut repasser
  // en quad plat.
  for (const prop of props()) {
    assert.ok(prop.radius <= 12, `${prop.front} à ${prop.radius} m ne mérite plus une boîte`);
  }
});

test('un objet proche a une profondeur réelle', () => {
  for (const prop of props()) assert.ok(prop.depth > 0.1, `${prop.front} est plat`);
});

test('aucun objet proche ne se cache derrière l_écran de jeu', () => {
  /*
   * Le défaut que ce test garde a été trouvé dans le casque le 2026-09-11, et
   * il était entier dans le plan : la rangée de blocs `?` était posée aux
   * azimuts -12, 0 et +12 degrés, c'est-à-dire pile derrière l'image du jeu.
   * Trois objets corrects, à la bonne hauteur, avec le bon dessin, et
   * invisibles depuis l'ancre - il fallait marcher six mètres de côté pour
   * les voir.
   *
   * CE QUE CE TEST NE GARDE PAS : les pupitres. Ils couvrent 36 à 84 degrés
   * de chaque côté, mais seulement de -7,8 à -41 degrés d'élévation, donc ils
   * ne cachent que ce qui est posé au sol - la rangée de blocs leur passe
   * au-dessus. La règle complète demanderait de comparer deux bandes
   * d'élévation contre `sceneLayout()`, et elle n'est pas écrite : l'en-tête
   * de `placement.ts` porte les nombres, et c'est tout ce qui tient
   * aujourd'hui le tuyau de devant à 96 degrés.
   *
   * L'ombre de l'écran est CALCULÉE (`screenShadow`) plutôt que constatée,
   * comme `screenReach` l'est pour le rideau : elle vaut 46 degrés, pas les 30
   * du réglage par défaut, et c'est l'écran PLAT au cran le plus proche qui
   * l'emporte - sa largeur se lit à la distance de référence, donc l'approcher
   * l'élargit en angle. Aucune relecture ne donne ce nombre.
   */
  const shadow = screenShadow();
  for (const prop of props()) {
    const width = ALL_ART[prop.front].rows[0].length / ART_PIXELS_PER_METRE;
    // Le bord de l'objet, pas son centre : un bloc d'un mètre à sept mètres
    // déborde de quatre degrés de part et d'autre.
    const half = Math.asin(width / 2 / prop.radius);
    // L'azimut ramené dans (-180, 180] : l'ombre est centrée sur le devant.
    const TURN = 2 * Math.PI;
    const signed = ((((prop.azimuth % TURN) + TURN) % TURN) + Math.PI) % TURN - Math.PI;
    const inner = Math.abs(signed) - half;
    assert.ok(
      inner > shadow,
      `${prop.front} à ${((signed * 180) / Math.PI).toFixed(1)}° : son bord entre à ` +
        `${((inner * 180) / Math.PI).toFixed(1)}°, l'écran en couvre ` +
        `${((shadow * 180) / Math.PI).toFixed(1)}°`
    );
  }
});
