/**
 * Le câblage du guetteur, une fois pour les trois présentations.
 *
 * Il a existé en deux copies identiques dans deux composants, et une
 * troisième présentation - la VR, qui passe par `rooms/lockstep-engine.ts` -
 * n'en avait aucune : un versus en casque ne comptait pas, sans que rien ne le
 * dise. C'est ce fichier qui rend cette situation impossible à reproduire.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatchRecorder } from '../../frontend/src/lib/games/match-recorder.js';
import type { MatchVerdict } from '../../frontend/src/lib/games/match-watch.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';

const DBZ2 = '8F24F886';

function ram(p1max: number, p1: number, p2max: number, p2: number): Uint8Array {
  const w = new Uint8Array(128 * 1024);
  const put = (at: number, value: number) => {
    w[at] = value & 0xff;
    w[at + 1] = (value >> 8) & 0xff;
  };
  put(0x0560, p1max);
  put(0x0562, p1);
  put(0x0660, p2max);
  put(0x0662, p2);
  return w;
}

test('une ROM non mesurée ne donne aucun enregistreur', () => {
  assert.equal(
    createMatchRecorder({
      crc32: 'DEADBEEF',
      wram: () => ram(100, 100, 100, 100),
      announce: () => {},
      report: () => {}
    }),
    null
  );
});

test('un salon sans checksum non plus', () => {
  assert.equal(
    createMatchRecorder({
      crc32: null,
      wram: () => ram(100, 100, 100, 100),
      announce: () => {},
      report: () => {}
    }),
    null
  );
});

test('un KO joué des deux côtés est annoncé et rapporté une fois', () => {
  const announced: MatchVerdict[] = [];
  const reported: MatchVerdict[] = [];
  let wram = ram(100, 100, 100, 100);
  const recorder = createMatchRecorder({
    crc32: DBZ2,
    wram: () => wram,
    announce: (verdict) => announced.push(verdict),
    report: (verdict) => reported.push(verdict)
  })!;

  // Le guetteur échantillonne une image sur 30 : rester sur des multiples.
  // L'image 0 arme et remet l'activité à zéro, donc ce sont les manettes de
  // l'image 30 qui doivent porter les deux appuis.
  recorder.onFrame(0, PAD.A, PAD.B);
  wram = ram(100, 80, 100, 0);
  recorder.onFrame(30, PAD.A, PAD.B);

  assert.equal(announced.length, 1);
  assert.equal(reported.length, 1);
  assert.equal(reported[0].winner, 1);
});

test('la garde vaut aussi pour le rapport, pas seulement pour la notification', () => {
  const reported: MatchVerdict[] = [];
  let wram = ram(100, 100, 100, 100);
  const recorder = createMatchRecorder({
    crc32: DBZ2,
    wram: () => wram,
    announce: () => {},
    report: (verdict) => reported.push(verdict)
  })!;

  recorder.onFrame(0, PAD.A, 0);
  wram = ram(100, 80, 100, 0);
  recorder.onFrame(30, PAD.A, 0);

  assert.deepEqual(reported, []);
});

test('le score annoncé est celui de l’observateur qui a produit le verdict', () => {
  const scores: (readonly [number, number])[] = [];
  let wram = ram(100, 100, 100, 100);
  const recorder = createMatchRecorder({
    crc32: DBZ2,
    wram: () => wram,
    announce: (_verdict, score) => scores.push(score),
    report: () => {}
  })!;

  recorder.onFrame(0, PAD.A, PAD.B);
  wram = ram(100, 80, 100, 0);
  recorder.onFrame(30, PAD.A, PAD.B);
  wram = ram(100, 100, 100, 100);
  recorder.onFrame(60, PAD.A, PAD.B);
  wram = ram(100, 0, 100, 60);
  recorder.onFrame(90, PAD.A, PAD.B);

  assert.deepEqual([...scores[0]], [1, 0]);
  assert.deepEqual([...scores[1]], [1, 1]);
});
