/**
 * La verticale du joueur : sauter, tomber, se poser.
 *
 * Un tir balistique se vérifie exactement, donc ces tests portent sur des
 * nombres et non sur des impressions - sauf le confort, que seul un casque
 * dira. Ce qu'ils tiennent : la hauteur promise, la hauteur minimale, et les
 * trois façons de passer à travers le sol.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  step,
  grounded,
  STANDING,
  JUMP_HEIGHT,
  JUMP_CUT,
  GRAVITY,
  type Vertical
} from '../../frontend/src/lib/vr/jump.js';

const DT = 1 / 72;

/** Saute, puis laisse courir jusqu'à l'atterrissage. Rend le sommet atteint. */
function arc(holdFor: number, support = 0): { apex: number; frames: number; landed: Vertical } {
  let at: Vertical = { y: support, velocity: 0 };
  let apex = support;
  let frames = 0;
  at = step(at, { pressed: true, holding: true, support, dt: DT });
  for (let t = 0; t < 5; t += DT) {
    frames++;
    at = step(at, { pressed: false, holding: t < holdFor, support, dt: DT });
    apex = Math.max(apex, at.y);
    if (grounded(at, support) && t > 0.1) break;
  }
  return { apex, frames, landed: at };
}

test('un saut tenu à fond monte à la hauteur promise', () => {
  const { apex } = arc(10);
  // Un pouillème sous les trois mètres : l'intégration avance par images, donc
  // le sommet exact tombe entre deux. Un centimètre à 72 Hz.
  assert.ok(Math.abs(apex - JUMP_HEIGHT) < 0.02, `${apex} au lieu de ${JUMP_HEIGHT}`);
});

test('un saut relâché tout de suite monte beaucoup moins haut', () => {
  /*
   * Le saut variable de Mario, et ce qui donne au bouton quelque chose à dire.
   * La hauteur minimale est le carré de la coupure : 0,55 au carré fait 0,30,
   * donc 0,9 m sur les trois.
   */
  const { apex } = arc(0);
  const wanted = JUMP_HEIGHT * JUMP_CUT * JUMP_CUT;
  assert.ok(Math.abs(apex - wanted) < 0.05, `${apex} au lieu de ${wanted}`);
  assert.ok(apex > 0.5, 'un saut minimal doit quand même être un saut');
});

test('plus on tient, plus haut on monte, sans exception', () => {
  let previous = 0;
  for (const hold of [0, 0.05, 0.1, 0.2, 0.3, 0.45, 1]) {
    const { apex } = arc(hold);
    assert.ok(apex >= previous - 1e-9, `tenir ${hold}s monte moins haut : ${apex} < ${previous}`);
    previous = apex;
  }
});

test('on retombe toujours, et on se pose exactement sur le sol', () => {
  const { landed } = arc(10);
  assert.equal(landed.y, 0);
  assert.equal(landed.velocity, 0);
});

test('on se pose sur un tuyau sans entrer dedans', () => {
  // Le support n'est pas toujours l'herbe : deux mètres, c'est le sommet d'un
  // tuyau, et c'est là que les pieds doivent s'arrêter.
  let at: Vertical = { y: 2.6, velocity: -1 };
  for (let i = 0; i < 100; i++) at = step(at, { pressed: false, holding: false, support: 2, dt: DT });
  assert.equal(at.y, 2);
  assert.ok(grounded(at, 2));
});

test('on ne saute pas en l_air', () => {
  /*
   * Sans cette garde, tenir le bouton donnerait un vol : chaque image poserait
   * une nouvelle vitesse initiale. C'est le défaut le plus courant d'un
   * premier contrôleur de saut.
   */
  let at = step(STANDING, { pressed: true, holding: true, support: 0, dt: DT });
  const rising = at.velocity;
  at = step(at, { pressed: true, holding: true, support: 0, dt: DT });
  assert.ok(at.velocity < rising, 'la vitesse doit décroître, pas se recharger');
});

test('une image sautée ne fait pas traverser le sol', () => {
  // Le casque saute des images à chaque ouverture de menu système. Intégrer un
  // demi-seconde d'un coup enverrait le joueur sous l'herbe, d'où il ne
  // remonterait jamais puisque le support est dessus.
  let at: Vertical = { y: 0.5, velocity: -1 };
  at = step(at, { pressed: false, holding: false, support: 0, dt: 3 });
  assert.ok(at.y >= 0, `passé sous le sol : ${at.y}`);
});

test('la gravité est celle qu_on a écrite, pas celle de la Terre', () => {
  // Une gravité de dessin animé est ce qui fait qu'un saut de trois mètres se
  // lit comme un saut et non comme un envol - et elle écourte la phase
  // aérienne, ce qui est le vrai levier de confort.
  const { frames } = arc(10);
  const airtime = frames * DT;
  assert.ok(airtime < 1, `${airtime} s en l_air, c_est trop long`);
  assert.ok(GRAVITY > 9.81 * 2);
});
