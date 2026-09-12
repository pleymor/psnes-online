/**
 * Se déplacer et tourner au stick, et les façons dont ça se casse en silence.
 *
 * Aucun de ces tests ne parle de confort - ça, seul un casque le dit. Ils
 * tiennent les propriétés dont la violation ne se voit PAS à la relecture : un
 * plafond de vitesse que la diagonale dépasse, une dérive d'un millimètre par
 * image, un cran qui part en rafale.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  walk,
  walkSpeed,
  snapTurn,
  smoothTurn,
  SNAP_READY,
  WALK_DEAD_ZONE,
  WALK_SPEED,
  TURN_STEP,
  TURN_SPEED,
  TURN_FIRE,
  TURN_REARM
} from '../../frontend/src/lib/vr/walk.js';

/** Regard vers -Z, droite vers +X : le repère de three au repos. */
const FORWARD = [0, -1] as const;
const RIGHT = [1, 0] as const;
const STEP = 1 / 72;

const step = (stick: readonly [number, number]) =>
  walk({ stick, forward: FORWARD, right: RIGHT, dt: STEP });

test('sous la zone morte, le pas est nul', () => {
  // Un pouce au repos lit rarement zéro. Sans zone morte, le monde dérive
  // pendant qu'on lit un titre - et une dérive lente est pire qu'un défaut
  // franc, parce qu'on la ressent sans la voir.
  for (const push of [0, 0.01, WALK_DEAD_ZONE - 1e-6, -WALK_DEAD_ZONE + 1e-6]) {
    assert.deepEqual(step([push, 0]), [0, 0], `${push} sur X a bougé`);
    assert.deepEqual(step([0, push]), [0, 0], `${push} sur Y a bougé`);
  }
});

test('la zone morte se mesure sur la LONGUEUR, pas sur chaque axe', () => {
  // Par axe, une diagonale à 0,12 sur chacun serait ignorée alors qu'elle est
  // clairement poussée - et deux seuils indépendants font des démarrages en
  // marche d'escalier sur les diagonales.
  const half = (WALK_DEAD_ZONE / Math.SQRT2) * 0.99;
  assert.deepEqual(step([half, half]), [0, 0], 'longueur sous le seuil');
  const over = (WALK_DEAD_ZONE / Math.SQRT2) * 1.5;
  assert.notDeepEqual(step([over, over]), [0, 0], 'longueur au-dessus');
});

test('mille images au repos ne produisent pas un millimètre', () => {
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const [dx, dz] = step([0.02, -0.03]);
    total += Math.hypot(dx, dz);
  }
  assert.equal(total, 0);
});

test('pousser plus fort n_avance jamais moins vite', () => {
  let previous = 0;
  for (let push = WALK_DEAD_ZONE; push <= 1; push += 0.05) {
    const travelled = Math.hypot(...step([0, -push]));
    assert.ok(travelled >= previous - 1e-12, `${push} recule : ${travelled} < ${previous}`);
    previous = travelled;
  }
});

test('la diagonale ne va pas plus vite que l_axe', () => {
  /*
   * L'erreur classique de ce genre de code, et elle est invisible en lisant :
   * additionner deux composantes à plein débattement donne racine de deux fois
   * la vitesse, donc on avance 41 % plus vite en biais.
   */
  const straight = Math.hypot(...step([0, -1]));
  const diagonal = Math.hypot(...step([1, -1]));
  assert.ok(diagonal <= straight + 1e-12, `diagonale ${diagonal} contre axe ${straight}`);
});

test('la vitesse ne dépasse jamais son plafond', () => {
  const travelled = Math.hypot(...step([1, -1]));
  assert.ok(
    travelled <= WALK_SPEED * STEP + 1e-12,
    `${travelled} m en une image de ${STEP} s`
  );
});

test('le regard décide de la direction, pas le monde', () => {
  // Tourné de 90 degrés, « avant » doit devenir « +X ». C'est tout l'intérêt
  // de recevoir les deux vecteurs plutôt qu'un angle.
  const turned = walk({ stick: [0, -1], forward: [1, 0], right: [0, 1], dt: STEP });
  assert.ok(turned[0] > 0 && Math.abs(turned[1]) < 1e-12, `${turned}`);
});

test('un cran fait trente degrés, et douze font le tour', () => {
  let total = 0;
  let state = SNAP_READY;
  for (let i = 0; i < 12; i++) {
    const fired = snapTurn(1, state);
    total += fired.yaw;
    // Le stick revient au centre entre deux poussées.
    state = snapTurn(0, fired.state).state;
  }
  assert.ok(Math.abs(Math.abs(total) - 2 * Math.PI) < 1e-9, `${total} au lieu d_un tour`);
  assert.ok(Math.abs(TURN_STEP - Math.PI / 6) < 1e-12);
});

test('un stick tenu à fond ne fait qu_UN cran', () => {
  /*
   * Le point du cran, et ce qui le distingue d'une rotation continue
   * saccadée : sans désarmement, tenir le stick ferait tourner à la fréquence
   * du casque, soit soixante-douze crans par seconde.
   */
  let state = SNAP_READY;
  let fired = 0;
  for (let i = 0; i < 200; i++) {
    const out = snapTurn(1, state);
    if (out.yaw !== 0) fired++;
    state = out.state;
  }
  assert.equal(fired, 1);
});

test('le cran se réarme en relâchant, pas en frôlant le seuil', () => {
  // L'hystérésis : avec un seul seuil, un pouce qui tremble autour de la
  // limite partirait en rafale.
  let state = snapTurn(1, SNAP_READY).state;
  assert.equal(state.armed, false);
  state = snapTurn((TURN_FIRE + TURN_REARM) / 2, state).state;
  assert.equal(state.armed, false, 'réarmé trop tôt');
  state = snapTurn(TURN_REARM - 0.01, state).state;
  assert.equal(state.armed, true, 'jamais réarmé');
});

test('pousser à droite tourne à droite, donc rend un lacet négatif', () => {
  /*
   * Le signe est celui de THREE, pas celui du pouce : une rotation positive
   * autour de +Y tourne vers la GAUCHE du joueur.
   *
   * Ce test disait l'inverse et passait, ce qui n'a rien empêché - le casque a
   * tranché en quatre mots, « le stick droit est inversé ». Un test qui encode
   * la convention qu'il devrait vérifier ne vérifie rien ; celui-ci nomme donc
   * le sens attendu du point de vue du JOUEUR, pas de l'axe.
   */
  assert.ok(snapTurn(1, SNAP_READY).yaw < 0, 'pousser à droite doit tourner à droite');
  assert.ok(snapTurn(-1, SNAP_READY).yaw > 0, 'pousser à gauche doit tourner à gauche');
  assert.ok(smoothTurn(1, 1 / 72) < 0);
  assert.ok(smoothTurn(-1, 1 / 72) > 0);
});

test('la rotation continue a la même zone morte et son plafond', () => {
  assert.equal(smoothTurn(WALK_DEAD_ZONE - 1e-6, STEP), 0);
  assert.ok(Math.abs(smoothTurn(1, STEP)) <= TURN_SPEED * STEP + 1e-12);
});

test('la vitesse rendue est celle du pas, et zéro à l_arrêt', () => {
  assert.equal(walkSpeed([0, 0], STEP), 0);
  assert.ok(Math.abs(walkSpeed([0, 0.5], 0.5) - 1) < 1e-12);
  // Un dt nul arrive à la première image : il rend zéro plutôt qu'un infini.
  assert.equal(walkSpeed([0, 1], 0), 0);
});
