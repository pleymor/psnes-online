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
import { DECOR_NEAR, SKY_RADIUS } from '../../frontend/src/lib/vr/decor/composition.js';
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
