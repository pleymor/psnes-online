/**
 * Marcher au stick, et les cinq façons dont ça se casse en silence.
 *
 * Aucun de ces tests ne parle de confort - ça, seul un casque le dit. Ils
 * tiennent les propriétés dont la violation ne se voit PAS à la relecture : un
 * plafond de vitesse que la diagonale dépasse, une dérive d'un millimètre par
 * image, une borne qui laisse fuir.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  walk,
  walkSpeed,
  WALK_DEAD_ZONE,
  WALK_SPEED,
  WALK_RADIUS
} from '../../frontend/src/lib/vr/walk.js';

/** Regard vers -Z, droite vers +X : le repère de three au repos. */
const FORWARD = [0, -1] as const;
const RIGHT = [1, 0] as const;
const STEP = 1 / 72;

function step(offset: readonly [number, number], stick: readonly [number, number]) {
  return walk({ offset, stick, forward: FORWARD, right: RIGHT, dt: STEP });
}

test('sous la zone morte, rien ne bouge d_un flottant', () => {
  // Un pouce au repos lit rarement zéro. Sans zone morte, le monde dérive
  // pendant qu'on lit un titre - et une dérive lente est pire qu'un défaut
  // franc, parce qu'on la ressent sans la voir.
  for (const push of [0, 0.01, WALK_DEAD_ZONE - 1e-6, -WALK_DEAD_ZONE + 1e-6]) {
    assert.deepEqual(step([0, 0], [push, 0]), [0, 0], `${push} sur X a bougé`);
    assert.deepEqual(step([0, 0], [0, push]), [0, 0], `${push} sur Y a bougé`);
  }
});

test('la zone morte se mesure sur la LONGUEUR, pas sur chaque axe', () => {
  /*
   * Ce test a d'abord été écrit faux, en poussant les deux axes à 0,149 et en
   * attendant l'immobilité : cette diagonale mesure 0,21, donc elle est
   * clairement poussée. Par axe, elle aurait été ignorée - et deux seuils
   * indépendants font des démarrages en marche d'escalier sur les diagonales.
   */
  const half = (WALK_DEAD_ZONE / Math.SQRT2) * 0.99;
  assert.deepEqual(step([0, 0], [half, half]), [0, 0], 'longueur sous le seuil');
  const over = (WALK_DEAD_ZONE / Math.SQRT2) * 1.5;
  assert.notDeepEqual(step([0, 0], [over, over]), [0, 0], 'longueur au-dessus');
});

test('un stick au repos ne dérive pas en mille images', () => {
  let at: [number, number] = [0, 0];
  for (let i = 0; i < 1000; i++) at = step(at, [0.02, -0.03]);
  assert.deepEqual(at, [0, 0]);
});

test('pousser plus fort n_avance jamais moins vite', () => {
  // La rampe est quadratique, donc douce près du seuil - mais monotone, sinon
  // le joueur corrige dans le mauvais sens sans comprendre pourquoi.
  let previous = 0;
  for (let push = WALK_DEAD_ZONE; push <= 1; push += 0.05) {
    const [, z] = step([0, 0], [0, -push]);
    const travelled = Math.abs(z);
    assert.ok(travelled >= previous - 1e-12, `${push} recule : ${travelled} < ${previous}`);
    previous = travelled;
  }
});

test('la diagonale ne va pas plus vite que l_axe', () => {
  /*
   * L'erreur classique de ce genre de code, et elle est invisible en lisant :
   * additionner deux composantes à plein débattement donne racine de deux fois
   * la vitesse, donc on avance 41 % plus vite en biais. Le test compare les
   * deux plutôt que de vérifier une formule.
   */
  const straight = step([0, 0], [0, -1]);
  const diagonal = step([0, 0], [1, -1]);
  const length = (v: readonly [number, number]) => Math.hypot(v[0], v[1]);
  assert.ok(
    length(diagonal) <= length(straight) + 1e-12,
    `diagonale ${length(diagonal)} contre axe ${length(straight)}`
  );
});

test('la vitesse ne dépasse jamais son plafond', () => {
  const [x, z] = step([0, 0], [1, -1]);
  assert.ok(
    Math.hypot(x, z) <= WALK_SPEED * STEP + 1e-12,
    `${Math.hypot(x, z)} m en une image de ${STEP} s`
  );
});

test('on ne sort jamais du disque, quelles que soient les poussées', () => {
  // Mille poussées au hasard : c'est la borne qui doit tenir, pas le chemin.
  let at: [number, number] = [0, 0];
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < 1000; i++) {
    at = step(at, [random(), random()]);
    assert.ok(Math.hypot(at[0], at[1]) <= WALK_RADIUS + 1e-9, `sorti à ${at}`);
  }
});

test('au bord, on glisse le long plutôt que de se cogner', () => {
  /*
   * Poussé droit dans le mur, puis en biais : le déplacement latéral doit
   * continuer. Une butée franche fige les deux axes d'un coup et se sent comme
   * un bug ; un glissement se sent comme un mur.
   */
  let at: [number, number] = [0, 0];
  for (let i = 0; i < 500; i++) at = step(at, [0, -1]);
  assert.ok(Math.abs(Math.hypot(...at) - WALK_RADIUS) < 1e-6, `pas au bord : ${at}`);
  const before = at[0];
  for (let i = 0; i < 20; i++) at = step(at, [1, -1]);
  assert.ok(at[0] > before + 0.05, `pas de glissement : ${before} puis ${at[0]}`);
});

test('le regard décide de la direction, pas le monde', () => {
  // Tourné de 90 degrés, « avant » doit devenir « +X ». C'est tout l'intérêt
  // de recevoir les deux vecteurs plutôt qu'un angle.
  const turned = walk({
    offset: [0, 0],
    stick: [0, -1],
    forward: [1, 0],
    right: [0, 1],
    dt: STEP
  });
  assert.ok(turned[0] > 0 && Math.abs(turned[1]) < 1e-12, `${turned}`);
});

test('la vitesse rendue est celle du pas, et zéro à l_arrêt', () => {
  assert.equal(walkSpeed([1, 1], [1, 1], STEP), 0);
  assert.ok(Math.abs(walkSpeed([0, 0], [0, 0.5], 0.5) - 1) < 1e-12);
  // Un dt nul arrive à la première image : il rend zéro plutôt qu'un infini.
  assert.equal(walkSpeed([0, 0], [0, 1], 0), 0);
});
