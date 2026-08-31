/**
 * Ce que fait le bouton « Salon » d'une carte de jeu.
 *
 * Comme `gameClick`, la règle vit dans une fonction nommée plutôt que dans une
 * chaîne de conditions au milieu d'un template : elle a trois branches, et la
 * troisième est celle que personne ne relit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { roomIntent } from '../../frontend/src/lib/rooms/room-intent.js';

const room = (status: 'waiting' | 'playing' | 'paused', id = 'r1') => ({ id, status }) as never;

test('sans salon, le bouton en ouvre un', () => {
  assert.deepEqual(roomIntent(null), { kind: 'create' });
  assert.deepEqual(roomIntent(undefined), { kind: 'create' });
});

test('avec un salon en attente, il y emmène en y posant ce jeu', () => {
  // Ouvrir un second salon laisserait le premier derrière soi, avec le lien
  // déjà partagé qui n'y mène plus.
  assert.deepEqual(roomIntent(room('waiting')), { kind: 'reuse', roomId: 'r1' });
});

test('pendant une partie, le bouton ne mène nulle part', () => {
  // Le serveur refuse de changer le jeu d'un salon qui joue, donc ce clic
  // n'aurait aucune destination.
  assert.deepEqual(roomIntent(room('playing')), { kind: 'blocked', reason: 'playing' });
  assert.deepEqual(roomIntent(room('paused')), { kind: 'blocked', reason: 'playing' });
});
