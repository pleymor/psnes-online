/**
 * L'arithmétique de la voix spatiale : où l'on entend un ami, et quand il parle.
 *
 * Sous Bun il n'y a ni `AudioContext` ni `PannerNode`, donc c'est ici qu'on
 * tient ce qui peut se tromper sans bruit : le sens de l'avant (une voix qui
 * vient de derrière quand l'ami est devant se lit comme « l'audio spatial est
 * raté » et se cherche dans le mauvais fichier), le repli non spatial, et les
 * seuils de l'anneau.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  rotate,
  listenerFrame,
  sourcePosition,
  distanceGain,
  rmsLevel,
  speakingStep,
  gameGainFor,
  micShown,
  SILENT,
  SPEAKING,
  FALLBACK_DISTANCE,
  DUCKED_GAME_GAIN,
  DISTANCE,
  type Vec3
} from '../../frontend/src/lib/vr/voice/spatial.js';
import type { Pose } from '../../frontend/src/lib/vr/lobby/roster.js';

function close(actual: Vec3, expected: Vec3, message?: string): void {
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9, `${message ?? ''} ${actual} ≠ ${expected}`);
  }
}

/** Une tête en `(x, y, z)` tournée de `yaw` radians autour de la verticale. */
function head(x: number, y: number, z: number, yaw = 0): Pose {
  return [x, y, z, 0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

test('sans rotation, l\'auditeur regarde vers -Z, tête en haut', () => {
  const frame = listenerFrame(head(1, 1.6, 2));
  close(frame.position, [1, 1.6, 2]);
  close(frame.forward, [0, 0, -1]);
  close(frame.up, [0, 1, 0]);
});

test('tourner la tête d\'un quart de tour à gauche fait regarder vers -X', () => {
  // Un lacet positif tourne dans le sens trigonométrique vu du dessus : de -Z vers -X.
  const frame = listenerFrame(head(0, 1.6, 0, Math.PI / 2));
  close(frame.forward, [-1, 0, 0]);
  close(frame.up, [0, 1, 0]);
});

test('un demi-tour fait regarder derrière soi', () => {
  close(listenerFrame(head(0, 0, 0, Math.PI)).forward, [0, 0, 1]);
});

test('lever le menton oriente l\'avant vers le haut et le haut vers l\'arrière', () => {
  // Tangage de +90° autour de X.
  const s = Math.SQRT1_2;
  const up: Pose = [0, 0, 0, s, 0, 0, s];
  close(rotate(up, [0, 0, -1]), [0, 1, 0]);
  close(rotate(up, [0, 1, 0]), [0, 0, 1]);
});

test('le quaternion opposé décrit la même orientation', () => {
  const q = head(0, 0, 0, 0.7);
  const opposite: Pose = [0, 0, 0, -q[3], -q[4], -q[5], -q[6]];
  close(listenerFrame(opposite).forward, listenerFrame(q).forward);
});

test('la voix d\'un ami est posée sur sa tête, dans le même repère', () => {
  close(sourcePosition(head(3, 1.7, -4), listenerFrame(head(0, 1.6, 0))), [3, 1.7, -4]);
});

test('sans pose d\'ami, la voix se tient devant l\'auditeur et le suit', () => {
  const facingLeft = listenerFrame(head(2, 1.6, 5, Math.PI / 2));
  close(sourcePosition(null, facingLeft), [2 - FALLBACK_DISTANCE, 1.6, 5]);
  // Et sans auditeur non plus : devant l'auditeur par défaut de Web Audio.
  close(sourcePosition(null, null), [0, 0, -FALLBACK_DISTANCE]);
});

test('l\'atténuation : pleine voix de près, jamais plus forte que pleine, décroissante ensuite', () => {
  assert.equal(distanceGain(0), 1);
  assert.equal(distanceGain(0.3), 1);
  assert.equal(distanceGain(DISTANCE.refDistance), 1);
  let previous = 1;
  for (const d of [2, 4, 8, 16]) {
    const g = distanceGain(d);
    assert.ok(g < previous, `${d} m devrait être plus bas que la distance précédente`);
    previous = g;
  }
  // À dix mètres on entend encore qu'il parle.
  assert.ok(distanceGain(10) > 0.1);
  // Plafonnée à `maxDistance`, comme Web Audio.
  assert.equal(distanceGain(1000), distanceGain(DISTANCE.maxDistance));
});

test('le niveau efficace : zéro pour le silence, l\'amplitude sur une onde carrée', () => {
  assert.equal(rmsLevel(new Float32Array(128)), 0);
  assert.equal(rmsLevel([]), 0);
  const square = Float32Array.from({ length: 256 }, (_, i) => (i % 2 ? 0.5 : -0.5));
  assert.ok(Math.abs(rmsLevel(square) - 0.5) < 1e-6);
});

test('l\'anneau s\'allume au-dessus du seuil et tient entre deux syllabes', () => {
  let s = SILENT;
  s = speakingStep(s, SPEAKING.ON * 2, 0);
  assert.equal(s.speaking, true);
  // Un creux sous `OFF`, plus court que le maintien : toujours allumé.
  s = speakingStep(s, 0, SPEAKING.HOLD_MS - 50);
  assert.equal(s.speaking, true);
  // Passé le maintien : éteint.
  s = speakingStep(s, 0, SPEAKING.HOLD_MS + 10);
  assert.equal(s.speaking, false);
});

test('entre les deux seuils, on garde l\'état : pas de clignotement', () => {
  const between = (SPEAKING.ON + SPEAKING.OFF) / 2;
  assert.equal(speakingStep(SILENT, between, 0).speaking, false);
  let s = speakingStep(SILENT, SPEAKING.ON, 0);
  // Un murmure prolongé entre les deux seuils ne l'éteint pas, même au-delà du maintien.
  for (let t = 100; t <= 2000; t += 100) s = speakingStep(s, between, t);
  assert.equal(s.speaking, true);
});

test('le jeu baisse quand un ami parle, et revient à l\'unité sinon', () => {
  assert.equal(gameGainFor(false), 1);
  assert.equal(gameGainFor(true), DUCKED_GAME_GAIN);
  assert.ok(DUCKED_GAME_GAIN > 0 && DUCKED_GAME_GAIN < 1, 'on baisse, on ne coupe pas');
});

test('coupé l\'emporte sur « personne à qui parler », mais pas sur un refus', () => {
  assert.equal(micShown('idle', true), 'muted');
  assert.equal(micShown('live', true), 'muted');
  assert.equal(micShown('live', false), 'live');
  assert.equal(micShown('denied', true), 'denied');
});
