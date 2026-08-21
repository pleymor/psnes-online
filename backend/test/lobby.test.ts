import test from 'node:test';
import assert from 'node:assert/strict';
import { requireGame } from '../src/rooms/require-game.js';
import { invitationState } from '../src/rooms/invitation-state.js';
import { romAvailability } from '../src/rooms/rom-availability.js';

const T0 = new Date('2026-08-21T12:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

test('requireGame rend le jeu quand il y en a un', () => {
  assert.deepEqual(requireGame({ gameId: 'g1', gameTitle: 'Chrono Trigger' }), {
    gameId: 'g1',
    gameTitle: 'Chrono Trigger'
  });
});

test('requireGame refuse un salon sans jeu', () => {
  assert.equal(requireGame({}), null);
});

test('requireGame refuse un jeu à moitié renseigné', () => {
  // Un identifiant sans titre est un état que rien ne devrait produire, donc
  // le laisser passer masquerait un bug ailleurs plutôt que de le révéler.
  assert.equal(requireGame({ gameId: 'g1' }), null);
  assert.equal(requireGame({ gameTitle: 'Chrono Trigger' }), null);
});

test('une invitation fraîche est en attente', () => {
  assert.equal(invitationState({ status: 'pending', expiresAt: plus(600_000) }, T0), 'pending');
});

test('une invitation acceptée le reste, même après son délai', () => {
  // L'état enregistré gagne : une invitation déjà acceptée ne doit pas
  // devenir expirée parce qu'on la relit plus tard.
  const accepted = { status: 'accepted' as const, expiresAt: plus(-1) };
  assert.equal(invitationState(accepted, plus(600_000)), 'accepted');
});

test('une invitation refusée le reste', () => {
  assert.equal(invitationState({ status: 'declined', expiresAt: plus(600_000) }, T0), 'declined');
});

test('une invitation en attente devient expirée passé son délai', () => {
  assert.equal(invitationState({ status: 'pending', expiresAt: plus(1) }, plus(2)), 'expired');
});

test('une invitation expire à la seconde exacte, pas après', () => {
  // La limite est celle qui se trompe : à l'instant pile, elle est expirée.
  const at = plus(600_000);
  assert.equal(invitationState({ status: 'pending', expiresAt: at }, at), 'expired');
});

test('la ROM est possédée quand le joueur a la ligne', () => {
  assert.equal(romAvailability({ gameCrc32: 'abc', playerOwnsChecksum: true }), 'has');
});

test('la ROM manque quand le joueur ne l a pas', () => {
  assert.equal(romAvailability({ gameCrc32: 'abc', playerOwnsChecksum: false }), 'missing');
});

test('sans checksum enregistré la réponse est inconnue, pas manquante', () => {
  // La colonne crc32 de Game est nullable. Dire "ne l'a pas" ici serait faux.
  assert.equal(romAvailability({ gameCrc32: undefined, playerOwnsChecksum: false }), 'unknown');
});

test('sans jeu choisi la réponse est inconnue', () => {
  assert.equal(romAvailability({ gameCrc32: null, playerOwnsChecksum: false }), 'unknown');
});
