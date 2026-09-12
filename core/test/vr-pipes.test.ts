/**
 * Se baisser, et voyager par les tuyaux.
 *
 * Ce que ces tests tiennent, c'est le CONFORT rendu en nombres : qu'on ne soit
 * jamais téléporté les yeux ouverts, et qu'un voyage finisse toujours. Le
 * reste - est-ce que c'est amusant - ne se teste pas.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  crouch,
  enter,
  advance,
  travelling,
  hidden,
  pipeUnder,
  NOT_TRAVELLING,
  CROUCH_DEPTH,
  CROUCH_THRESHOLD,
  PIPE_DIP,
  PIPE_PHASE,
  type Pipe
} from '../../frontend/src/lib/vr/pipes.js';

const A: Pipe = { at: [0, -9], top: 2 };
const B: Pipe = { at: [9, 0], top: 2 };
const PIPES = [A, B];
const DT = 1 / 72;

test('s_accroupir est franc, jamais à moitié', () => {
  // Un accroupissement qui suivrait le pouce ferait osciller la tête du
  // joueur, ce qui est le contraire du confort recherché.
  assert.equal(crouch(0), 0);
  assert.equal(crouch(CROUCH_THRESHOLD - 0.01), 0);
  assert.equal(crouch(1), CROUCH_DEPTH);
  // Vers le haut, jamais : l'axe Y est positif vers le bas.
  assert.equal(crouch(-1), 0);
});

test('on n_entre dans un tuyau que si on est dessus ET qu_on se baisse', () => {
  assert.equal(enter(A.at, A.top, false, PIPES).kind, 'none', 'debout');
  assert.equal(enter([5, 5], 0, true, PIPES).kind, 'none', 'ailleurs');
  assert.equal(enter(A.at, 0, true, PIPES).kind, 'none', 'au pied du tuyau');
  assert.equal(enter(A.at, A.top, true, PIPES).kind, 'down', 'dessus et baissé');
});

test('un seul tuyau ne mène nulle part', () => {
  assert.equal(enter(A.at, A.top, true, [A]).kind, 'none');
});

test('on ressort par le tuyau SUIVANT, en tournant', () => {
  let travel = enter(A.at, A.top, true, PIPES);
  for (let i = 0; i < 200 && travel.kind === 'down'; i++) travel = advance(travel, DT);
  assert.equal(travel.kind, 'up');
  assert.deepEqual(travelling(travel)?.at, B.at);
});

test('un voyage finit toujours, et rend la main', () => {
  let travel = enter(A.at, A.top, true, PIPES);
  for (let i = 0; i < 500 && travel.kind !== 'none'; i++) travel = advance(travel, DT);
  assert.equal(travel.kind, 'none');
  assert.equal(travelling(travel), null);
});

test('on descend puis on remonte, sans jamais dépasser la course', () => {
  let travel = enter(A.at, A.top, true, PIPES);
  let lowest = A.top;
  for (let i = 0; i < 500 && travel.kind !== 'none'; i++) {
    travel = advance(travel, DT);
    const where = travelling(travel);
    if (!where) continue;
    lowest = Math.min(lowest, where.y);
    assert.ok(where.y <= A.top + 1e-9, `remonté trop haut : ${where.y}`);
    assert.ok(where.y >= A.top - PIPE_DIP - 1e-9, `descendu trop bas : ${where.y}`);
  }
  assert.ok(Math.abs(lowest - (A.top - PIPE_DIP)) < 0.05, `jamais descendu : ${lowest}`);
});

test('la téléportation a lieu les yeux fermés', () => {
  /*
   * L'assertion qui porte tout le confort de ce module. Un déplacement que le
   * corps ne sent pas est acceptable exactement tant qu'on ne le VOIT pas :
   * l'image où l'on change de tuyau doit donc être une image masquée.
   */
  let travel = enter(A.at, A.top, true, PIPES);
  let previous = travelling(travel)?.at;
  for (let i = 0; i < 500 && travel.kind !== 'none'; i++) {
    travel = advance(travel, DT);
    const where = travelling(travel);
    if (!where) break;
    const moved = previous && Math.hypot(where.at[0] - previous[0], where.at[1] - previous[1]) > 0.1;
    if (moved) assert.ok(hidden(travel), 'déplacé alors que le monde est visible');
    previous = where.at;
  }
});

test('le voyage dure ce qu_il annonce', () => {
  let travel = enter(A.at, A.top, true, PIPES);
  let seconds = 0;
  while (travel.kind !== 'none' && seconds < 5) {
    travel = advance(travel, DT);
    seconds += DT;
  }
  assert.ok(Math.abs(seconds - PIPE_PHASE * 2) < 0.05, `${seconds} s au lieu de ${PIPE_PHASE * 2}`);
});

test('on est sur un tuyau quand on est dessus, pas à côté ni dessous', () => {
  assert.equal(pipeUnder(A.at, A.top, PIPES), A);
  assert.equal(pipeUnder([A.at[0] + 2, A.at[1]], A.top, PIPES), null);
  assert.equal(pipeUnder(A.at, 0, PIPES), null);
});

test('un dt nul ne fait pas avancer, et n_est pas une erreur', () => {
  const travel = enter(A.at, A.top, true, PIPES);
  assert.deepEqual(advance(travel, 0), travel);
  assert.equal(advance(NOT_TRAVELLING, DT).kind, 'none');
});
