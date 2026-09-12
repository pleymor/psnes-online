/**
 * Se cogner au décor, et les trois façons dont une collision se rate.
 *
 * Elle laisse passer, elle colle, ou elle éjecte. Les tests qui suivent
 * tiennent les trois, et le dernier est le plus important : un joueur bloqué
 * dans un coin doit rester où il est, jamais être projeté ailleurs.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { slide, BODY_RADIUS, type Obstacle } from '../../frontend/src/lib/vr/collide.js';

/** Un mur d'un mètre de côté, droit devant, à trois mètres. */
const WALL: Obstacle = { at: [0, -3], halfWidth: 1, halfDepth: 0.2, yaw: 0 };

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
    { at: [-0.5, -3], halfWidth: 0.4, halfDepth: 0.4, yaw: 0 },
    { at: [0.5, -3], halfWidth: 0.4, halfDepth: 0.4, yaw: 0 }
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
