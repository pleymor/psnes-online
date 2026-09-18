/**
 * L'identifiant d'une session de jeu, et les transitions qui le renouvellent.
 *
 * Toutes les écritures de `status = 'playing'` ne sont pas des débuts de
 * partie, et c'est tout le piège : reprendre après une pause en est une, et
 * restamper là casserait la déduplication autour de la pause - deux rapports
 * du même KO porteraient deux identifiants, et la ligne serait écrite deux
 * fois.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { beginPlaySession } from '../src/rooms/play-session.js';
import type { Room } from '../src/types/index.js';

function room(): Room {
  return {
    id: 'r1',
    hostId: 'u1',
    createdBy: 'u1',
    players: [],
    status: 'waiting',
    emulationMode: 'lockstep',
    latencyMode: 'auto',
    createdAt: new Date()
  } as Room;
}

test('commencer une partie met le salon en jeu et lui donne une session', () => {
  const r = room();
  beginPlaySession(r);
  assert.equal(r.status, 'playing');
  assert.ok(r.playSessionId, 'une session doit être posée');
});

test('deux parties successives dans le même salon ont deux sessions', () => {
  const r = room();
  beginPlaySession(r);
  const first = r.playSessionId;
  beginPlaySession(r);
  assert.notEqual(r.playSessionId, first);
});
