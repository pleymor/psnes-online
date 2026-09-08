/**
 * La forme de l'écran : distance, taille angulaire, courbure.
 *
 * Trois invariants portants, et le premier est le moins évident.
 *
 * La taille est un ANGLE, pas une largeur. L'écran est un segment de cylindre
 * dont l'arc est fixé par ce réglage, donc sa largeur suit son rayon : le
 * reculer ne le fait pas paraître plus petit d'un degré. Distance et taille
 * sont deux axes indépendants parce que la taille est angulaire ; en mètres,
 * l'un annulerait l'autre.
 *
 * Le défaut doit reproduire à l'identique la géométrie livrée avant ce
 * réglage - 2,5 m, 60 degrés, incurvé - sinon la mise à jour déplace l'écran
 * de tous les joueurs qui n'ont rien demandé.
 *
 * La distance minimale n'est pas un goût : la tablette des options flotte à
 * 1,54 m des yeux, DEVANT l'écran, et il lui faut de la séparation - pas
 * seulement l'ordre - pour garder sa parallaxe. C'est l'invariance que
 * `vr-layout.test.ts` tient déjà, vérifiée ici parce que c'est ici que la
 * borne vit.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SHAPE,
  SCREEN_DISTANCES,
  SCREEN_ANGLES,
  SCREEN_HEIGHTS,
  SCREEN_SHAPE_KEY,
  stepDistance,
  stepAngle,
  stepHeight,
  readScreenShape,
  writeScreenShape,
  type ScreenShape
} from '../../frontend/src/lib/vr/screen-shape.js';

function storage(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => { held.set(key, value); },
    removeItem: (key: string) => { held.delete(key); },
    held
  };
}

test('le défaut est la géométrie livrée avant le réglage', () => {
  // 2,5 m et 60 degrés étaient `SCREEN_RADIUS` et `SCREEN_ARC` dans
  // `layout.ts`, l'écran a toujours été incurvé, et il a toujours été au
  // niveau des yeux - `centerY` valait zéro en dur.
  assert.deepEqual(DEFAULT_SHAPE, { distance: 2.5, angle: 60, height: 0, curved: true });
});

test('le défaut est sur les trois échelles', () => {
  // Sans ça, un joueur qui n'a rien touché ne pourrait pas revenir au défaut
  // par les boutons - il n'y aurait pas de cran pour ça.
  assert.ok(SCREEN_DISTANCES.includes(DEFAULT_SHAPE.distance));
  assert.ok(SCREEN_ANGLES.includes(DEFAULT_SHAPE.angle));
  assert.ok(SCREEN_HEIGHTS.includes(DEFAULT_SHAPE.height));
});

test('la hauteur est centrée sur le niveau des yeux et symétrique', () => {
  // Zéro est le niveau des yeux au dernier recentrage, donc il doit être un
  // cran - et les deux sens doivent aller aussi loin, un joueur pouvant aussi
  // bien avoir recentré trop haut que trop bas.
  assert.ok(SCREEN_HEIGHTS.includes(0));
  assert.equal(Math.min(...SCREEN_HEIGHTS), -Math.max(...SCREEN_HEIGHTS));
});

test('un cran de hauteur monte, un cran descend, et rien d autre ne bouge', () => {
  const up = stepHeight(DEFAULT_SHAPE, 1);
  assert.equal(up.height, 0.2);
  assert.equal(stepHeight(up, -1).height, 0);
  assert.equal(up.distance, DEFAULT_SHAPE.distance);
  assert.equal(up.angle, DEFAULT_SHAPE.angle);

  const bottom: ScreenShape = { ...DEFAULT_SHAPE, height: Math.min(...SCREEN_HEIGHTS) };
  assert.deepEqual(stepHeight(bottom, -1), bottom, 'le bas doit buter');
  const top: ScreenShape = { ...DEFAULT_SHAPE, height: Math.max(...SCREEN_HEIGHTS) };
  assert.deepEqual(stepHeight(top, 1), top, 'le haut doit buter');
});

test('une forme d avant le réglage de hauteur garde ce qu elle avait', () => {
  // Elle est complétée à zéro plutôt que jetée : c'est exactement ce que ce
  // joueur voyait, et lui reprendre sa distance et sa taille pour un champ qui
  // n'existait pas encore serait gratuit.
  const before = storage({ [SCREEN_SHAPE_KEY]: '{"distance":3,"angle":45,"curved":false}' });
  assert.deepEqual(readScreenShape(before), {
    distance: 3, angle: 45, height: 0, curved: false
  });
  assert.equal(before.held.has(SCREEN_SHAPE_KEY), true, 'elle ne doit pas être retirée');
});

test('la distance la plus proche laisse la tablette flotter devant l écran', () => {
  // La tablette est à 1,54 m des yeux (`layout.ts`), et l'ordre ne suffit pas :
  // il faut de la séparation, sinon plus de parallaxe et plus d'effet
  // flottant. `vr-layout.test.ts` vérifie la même chose depuis l'autre bout,
  // sur la grille entière des réglages.
  assert.ok(Math.min(...SCREEN_DISTANCES) > 1.54 + 0.4, 'la tablette colle à l écran');
});

test('les deux échelles sont croissantes', () => {
  for (const ladder of [SCREEN_DISTANCES, SCREEN_ANGLES]) {
    for (let i = 1; i < ladder.length; i++) {
      assert.ok(ladder[i] > ladder[i - 1], `${ladder[i]} ne suit pas ${ladder[i - 1]}`);
    }
  }
});

test('un cran monte, un cran descend', () => {
  const up = stepDistance(DEFAULT_SHAPE, 1);
  assert.equal(up.distance, 3.0);
  assert.equal(stepDistance(up, -1).distance, DEFAULT_SHAPE.distance);

  const wider = stepAngle(DEFAULT_SHAPE, 1);
  assert.equal(wider.angle, 70);
  assert.equal(stepAngle(wider, -1).angle, DEFAULT_SHAPE.angle);
});

test('un cran ne change que son axe', () => {
  const stepped = stepDistance(DEFAULT_SHAPE, 1);
  assert.equal(stepped.angle, DEFAULT_SHAPE.angle);
  assert.equal(stepped.curved, DEFAULT_SHAPE.curved);

  const widened = stepAngle({ ...DEFAULT_SHAPE, curved: false }, -1);
  assert.equal(widened.distance, DEFAULT_SHAPE.distance);
  assert.equal(widened.curved, false);
});

test('les bouts butent au lieu de boucler', () => {
  // Boucler de 3,6 m à 1,8 m ferait sauter l'écran à la figure du joueur pour
  // un clic de trop sur « + ».
  const far: ScreenShape = { ...DEFAULT_SHAPE, distance: SCREEN_DISTANCES[SCREEN_DISTANCES.length - 1] };
  assert.deepEqual(stepDistance(far, 1), far);

  const near: ScreenShape = { ...DEFAULT_SHAPE, distance: SCREEN_DISTANCES[0] };
  assert.deepEqual(stepDistance(near, -1), near);

  const widest: ScreenShape = { ...DEFAULT_SHAPE, angle: SCREEN_ANGLES[SCREEN_ANGLES.length - 1] };
  assert.deepEqual(stepAngle(widest, 1), widest);
});

test('rien de stocké rend le défaut', () => {
  assert.deepEqual(readScreenShape(storage()), DEFAULT_SHAPE);
});

test('le défaut est retiré plutôt qu écrit', () => {
  // La même discipline que `pad-map.ts` et `shader-preference.ts` : aucun
  // lecteur n'a à traiter « le défaut stocké » et « rien » comme deux cas.
  const store = storage({ [SCREEN_SHAPE_KEY]: '{"distance":3,"angle":45,"curved":false}' });
  writeScreenShape(store, DEFAULT_SHAPE);
  assert.equal(store.held.has(SCREEN_SHAPE_KEY), false);
});

test('une forme choisie est écrite et se relit identique', () => {
  const store = storage();
  const chosen: ScreenShape = { distance: 2.0, angle: 80, height: -0.4, curved: false };
  writeScreenShape(store, chosen);
  assert.deepEqual(readScreenShape(store), chosen);
});

test('une valeur illisible ou hors échelle est retirée et rend le défaut', () => {
  // Hors échelle compris : rien n'empêche un joueur d'éditer son localStorage,
  // et un écran à trente centimètres de ses yeux n'est pas un réglage, c'est
  // une panne dont il ne pourrait pas sortir - le panneau des options serait
  // derrière l'image.
  const junk = [
    '{', 'nonsense', '[]', 'null',
    '{"distance":0.3,"angle":60,"curved":true}',
    '{"distance":1.8,"angle":60,"curved":true}',
    '{"distance":2.5,"angle":179,"curved":true}',
    '{"distance":2.5,"angle":60,"height":9,"curved":true}',
    '{"distance":"2.5","angle":60,"curved":true}'
  ];
  for (const value of junk) {
    const store = storage({ [SCREEN_SHAPE_KEY]: value });
    assert.deepEqual(readScreenShape(store), DEFAULT_SHAPE, `${value} n'a pas rendu le défaut`);
    assert.equal(store.held.has(SCREEN_SHAPE_KEY), false, `${value} est resté stocké`);
  }
});
