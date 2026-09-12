/**
 * Se cogner au décor, et les trois façons dont une collision se rate.
 *
 * Elle laisse passer, elle colle, ou elle éjecte. Les tests qui suivent
 * tiennent les trois, et le dernier est le plus important : un joueur bloqué
 * dans un coin doit rester où il est, jamais être projeté ailleurs.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  slide,
  supportAt,
  BODY_RADIUS,
  type Obstacle
} from '../../frontend/src/lib/vr/collide.js';

/** Un mur d'un mètre de côté, droit devant, à trois mètres. */
const WALL: Obstacle = { at: [0, -3], halfWidth: 1, halfDepth: 0.2, yaw: 0, top: 2 };

const distance = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Comparé à une tolérance et non à l'identique.
 *
 * `slide` découpe le pas pour qu'aucun obstacle mince ne puisse être traversé,
 * et ce découpage additionne des flottants : arriver « exactement » où on
 * voulait n'a plus de sens au dernier bit. Un micron est mille fois plus fin
 * que ce qu'un casque peut montrer.
 */
const arrivedAt = (
  at: readonly [number, number],
  wanted: readonly [number, number],
  what: string
) => assert.ok(distance(at, wanted) < 1e-6, `${what} : ${at} au lieu de ${wanted}`);

test('sans obstacle, on va exactement où on voulait', () => {
  arrivedAt(slide([0, 0], [1, -2], []), [1, -2], 'trajet libre dévié');
});

test('on ne rentre pas dans un mur', () => {
  const at = slide([0, -2], [0, -3], [WALL]);
  // Le bord du mur plus le rayon du corps : on s'arrête devant, pas dedans.
  assert.ok(at[1] <= -3 + WALL.halfDepth + BODY_RADIUS + 1e-9, `entré à ${at}`);
  assert.ok(at[1] >= -3 + WALL.halfDepth + BODY_RADIUS - 1e-9, `arrêté trop loin à ${at}`);
});

test('on glisse le long du mur au lieu de s_y coller', () => {
  /*
   * Le point de la méthode du plus petit dégagement : poussé en biais contre
   * un mur, le joueur continue LATÉRALEMENT. Une butée franche fige les deux
   * axes d'un coup et se sent comme un bug.
   */
  const at = slide([0, -2.7], [0.5, -3.2], [WALL]);
  assert.ok(at[0] > 0.3, `pas de glissement latéral : ${at}`);
});

test('un obstacle qu_on frôle sans le toucher ne change rien', () => {
  const wanted: [number, number] = [1 + WALL.halfWidth + BODY_RADIUS + 0.01, -3];
  arrivedAt(slide([3, -3], wanted, [WALL]), wanted, 'frôlement dévié');
});

test('le lacet d_un obstacle est respecté', () => {
  /*
   * Le même mur tourné d'un quart de tour barre l'autre axe : sa largeur court
   * désormais le long de Z, et c'est sa PROFONDEUR qui arrête un joueur venant
   * de l'ouest.
   *
   * Ce test a d'abord été écrit avec le mur à l'origine, donc avec le joueur
   * DEDANS au départ - le cas dégénéré, où aucune collision ne veut rien dire.
   */
  const turned: Obstacle = { ...WALL, at: [2, 0], yaw: Math.PI / 2 };
  const across = slide([0, 0], [3, 0], [turned]);
  const stop = 2 - WALL.halfDepth - BODY_RADIUS;
  assert.ok(across[0] <= stop + 1e-9, `traversé : ${across}`);
});

test('coincé entre deux obstacles, on reste sur place plutôt que d_être éjecté', () => {
  /*
   * Le défaut le plus désagréable d'une collision naïve, et le plus difficile
   * à diagnostiquer dans un casque : deux obstacles qui se repoussent l'un
   * l'autre projettent le joueur à l'autre bout du monde en une image. Rester
   * immobile est toujours valable ; être téléporté ne l'est jamais.
   */
  const jaws: Obstacle[] = [
    { at: [-0.5, -3], halfWidth: 0.4, halfDepth: 0.4, yaw: 0, top: 2 },
    { at: [0.5, -3], halfWidth: 0.4, halfDepth: 0.4, yaw: 0, top: 2 }
  ];
  const from: [number, number] = [0, -2.5];
  const at = slide(from, [0, -3], jaws);
  assert.ok(distance(at, from) <= 0.5 + BODY_RADIUS, `éjecté de ${distance(at, from)} m`);
});

test('mille pas contre un mur ne le traversent jamais', () => {
  let at: [number, number] = [0, 0];
  for (let i = 0; i < 1000; i++) at = slide(at, [at[0], at[1] - 0.05], [WALL]);
  assert.ok(at[1] > -3, `passé au travers : ${at}`);
});

test('ce qui est sous les pieds ne barre plus le passage', () => {
  /*
   * Sans ce filtre, un joueur au sommet d'un tuyau serait repoussé par ses
   * flancs : il ne pourrait ni y monter ni s'y tenir. C'est la condition pour
   * que le saut serve à quelque chose.
   */
  const overIt = slide([0, -2], [0, -3], [WALL], WALL.top + 0.01);
  assert.ok(Math.abs(overIt[1] + 3) < 1e-9, `arrêté en l'air : ${overIt}`);
  const underIt = slide([0, -2], [0, -3], [WALL], WALL.top - 0.5);
  assert.ok(underIt[1] > -3, `traversé à mi-hauteur : ${underIt}`);
});

test('on se tient sur ce qui est sous ses pieds, et sur rien d_autre', () => {
  // Au-dessus : le sommet porte. À côté : l'herbe. Dessous : l'herbe aussi,
  // parce qu'un plafond n'est pas un sol.
  assert.equal(supportAt([0, -3], WALL.top, [WALL]), WALL.top);
  assert.equal(supportAt([5, -3], WALL.top, [WALL]), 0);
  assert.equal(supportAt([0, -3], 0.5, [WALL]), 0);
});

test('en descendant, on accroche le sommet sans le rater entre deux images', () => {
  /*
   * La tolérance de `supportAt` : à treize mètres par seconde, une image
   * couvre dix-huit centimètres. Exiger l'égalité exacte ferait traverser le
   * tuyau une fois sur deux, ce qui est le pire des défauts - intermittent.
   */
  assert.equal(supportAt([0, -3], WALL.top + 0.04, [WALL]), WALL.top);
});

test('le plus haut des supports gagne', () => {
  const low: Obstacle = { at: [0, -3], halfWidth: 1, halfDepth: 1, yaw: 0, top: 0.9 };
  assert.equal(supportAt([0, -3], 2, [low, WALL]), WALL.top);
});
