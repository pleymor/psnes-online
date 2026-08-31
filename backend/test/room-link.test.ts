import test from 'node:test';
import assert from 'node:assert/strict';
import { getJoinableRoom, mayEnterByLink } from '../src/websocket/guards.js';
import type { Room } from '../src/types/index.js';

/*
 * Le lien de salon comme clé, pour les comptes aussi.
 *
 * La porte sans compte ouverte par #20 admettait le porteur du lien, mais
 * `mayEnterRoom` répond `false` pour un compte : un ami connecté se faisait
 * refuser là où un inconnu sans compte entrait. Ces tests fixent la règle qui
 * lève l'asymétrie, et surtout ses deux limites.
 */

function room(id: string, status: Room['status'], players: string[] = []): Room {
  return {
    id,
    status,
    players: players.map(userId => ({ userId, pseudo: userId, port: 1, isReady: true })),
  } as unknown as Room;
}

test('un compte entre dans un salon en attente dont il tient le lien', () => {
  assert.equal(mayEnterByLink({ isAnonymous: false }, room('r1', 'waiting')), true);
});

test('un compte n entre pas dans une partie déjà lancée', () => {
  // Le lien sert à se retrouver avant de jouer. Une partie en cours n'est pas
  // un point de rendez-vous, et s'y inviter dérangerait deux joueurs.
  assert.equal(mayEnterByLink({ isAnonymous: false }, room('r1', 'playing')), false);
  assert.equal(mayEnterByLink({ isAnonymous: false }, room('r1', 'paused')), false);
});

test('un salon inexistant n ouvre rien', () => {
  assert.equal(mayEnterByLink({ isAnonymous: false }, undefined), false);
});

test('la règle des anonymes reste celle de leur session, pas du lien reçu', () => {
  // Garde-fou de non-régression : #20 lie l'anonyme au salon nommé par sa
  // session. Cette porte-ci ne doit pas lui en ouvrir une seconde.
  assert.equal(mayEnterByLink({ isAnonymous: true }, room('r1', 'waiting')), false);
});

test('getJoinableRoom admet un compte non membre sur un salon en attente', () => {
  const rooms = new Map<string, Room>([['r1', room('r1', 'waiting', ['hote'])]]);
  const found = getJoinableRoom(rooms, 'r1', { id: 'visiteur', isAnonymous: false }, {}, 'room:join');
  assert.equal(found?.id, 'r1');
});

test('getJoinableRoom refuse toujours un compte sur une partie en cours', () => {
  const rooms = new Map<string, Room>([['r1', room('r1', 'playing', ['hote'])]]);
  const found = getJoinableRoom(rooms, 'r1', { id: 'visiteur', isAnonymous: false }, {}, 'room:join');
  assert.equal(found, null);
});

test('un membre garde son accès quel que soit l état du salon', () => {
  // Sans ça, l'hôte d'une partie en cours perdrait sa propre room.
  const rooms = new Map<string, Room>([['r1', room('r1', 'playing', ['hote'])]]);
  const found = getJoinableRoom(rooms, 'r1', { id: 'hote', isAnonymous: false }, {}, 'room:join');
  assert.equal(found?.id, 'r1');
});
