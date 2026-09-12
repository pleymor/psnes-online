/**
 * Rendre le salon quand une partie s'arrête, ou meurt avant d'avoir commencé.
 *
 * Deux façons de rendre un salon, et les confondre coûte cher dans les deux
 * sens. Un salon que le casque s'est créé pour lui-même n'a qu'un membre :
 * le quitter et le détruire sont le même acte. Un salon de GROUPE ne se quitte
 * jamais ainsi - `room:leave` est ce qui dissout un groupe de deux, exactement
 * ce que quitter une partie partagée ne doit pas faire. On y détache le jeu
 * (`room:release-game`) et le siège de l'ami survit.
 *
 * Le défaut qui a motivé l'extraction, rapporté de la production le
 * 2026-09-12 : la condition portait `players.length >= 2`, donc un salon de
 * groupe où il ne restait qu'UNE personne ne rendait rien du tout. Le moteur
 * mourait au lancement, le `catch` appelait la fonction en croyant nettoyer,
 * et le salon restait en `playing` avec un jeu mort dedans - après quoi
 * l'écran de lancement refusait toute nouvelle partie par « ce salon joue
 * déjà », sans qu'aucune sortie existe depuis le casque.
 *
 * Rendre un jeu ne dissout rien : le serveur remet le salon en `waiting` et
 * efface le jeu. Le nombre de joueurs n'a donc jamais été le bon critère.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { giveUpAction } from '../../frontend/src/lib/rooms/give-up-room.js';
import type { GroupRoom } from '../../frontend/src/lib/rooms/game-click.js';

const playing = (players: number): GroupRoom => ({
  id: 'r1',
  status: 'playing',
  players: Array.from({ length: players }, (_, i) => ({ userId: `u${i}` }))
});

test('un salon que le casque possède est quitté pour de bon', () => {
  // Solo : un seul membre, donc le quitter et le détruire sont le même acte.
  assert.deepEqual(giveUpAction('own-1', null), { kind: 'leave', roomId: 'own-1' });
});

test("le salon possédé l'emporte sur celui du groupe, sans quoi on rendrait le mauvais", () => {
  assert.deepEqual(giveUpAction('own-1', playing(2)), { kind: 'leave', roomId: 'own-1' });
});

test('un salon de groupe qui joue rend son jeu, et garde ses membres', () => {
  assert.deepEqual(giveUpAction(null, playing(2)), { kind: 'release', roomId: 'r1' });
});

test("un salon de groupe où il ne reste qu'une personne le rend AUSSI - le défaut de production", () => {
  /*
   * La ligne qui manquait. `players.length >= 2` laissait ce salon-là en
   * `playing` avec un jeu mort, et le casque n'avait plus aucune sortie :
   * le seul émetteur non gardé de `room:release-game` est la page plate.
   */
  assert.deepEqual(giveUpAction(null, playing(1)), { kind: 'release', roomId: 'r1' });
});

test("un salon qui n'a pas commencé à jouer ne doit rien", () => {
  // Silencieux quand rien n'est dû, pour rester appelable deux fois.
  assert.deepEqual(giveUpAction(null, { id: 'r1', status: 'waiting', players: [] }), {
    kind: 'none'
  });
});

test('sans salon du tout, rien à rendre', () => {
  assert.deepEqual(giveUpAction(null, null), { kind: 'none' });
  assert.deepEqual(giveUpAction(null, undefined), { kind: 'none' });
});
