import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { requireGame } from '../src/rooms/require-game.js';
import { invitationState } from '../src/rooms/invitation-state.js';
import {
  createInvitation,
  findInvitationById,
  listPendingInvitationsFor,
  markInvitation,
  deleteInvitationsForRoom
} from '../src/db/invitations.js';
import { migratedDb, insertUser } from './helpers.js';

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

test('une invitation créée se relit avec les mêmes champs, et ses dates sont des Date', () => {
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  const expiresAt = new Date(T0.getTime() + 600_000);

  const created = createInvitation(db, 'room-1', from.id, to.id, expiresAt);
  const found = findInvitationById(db, created.id);

  assert.ok(found);
  assert.equal(found.roomId, 'room-1');
  assert.equal(found.fromUserId, from.id);
  assert.equal(found.toUserId, to.id);
  assert.equal(found.status, 'pending');
  // C'est ce test qui compte : une date restée en nombre fait échouer la
  // comparaison de `invitationState` sans rien casser visiblement.
  assert.ok(found.createdAt instanceof Date);
  assert.ok(found.expiresAt instanceof Date);
  assert.equal(found.expiresAt.getTime(), expiresAt.getTime());
  db.close();
});

test('listPendingInvitationsFor ne rend pas celles acceptées ou refusées', () => {
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  const expiresAt = new Date(T0.getTime() + 600_000);

  const pending = createInvitation(db, 'room-1', from.id, to.id, expiresAt);
  const accepted = createInvitation(db, 'room-2', from.id, to.id, expiresAt);
  const declined = createInvitation(db, 'room-3', from.id, to.id, expiresAt);
  markInvitation(db, accepted.id, 'accepted');
  markInvitation(db, declined.id, 'declined');

  const rendered = listPendingInvitationsFor(db, to.id);

  assert.deepEqual(rendered.map(i => i.id), [pending.id]);
  db.close();
});

test('markInvitation change l état, et findInvitationById le voit', () => {
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  const expiresAt = new Date(T0.getTime() + 600_000);
  const invitation = createInvitation(db, 'room-1', from.id, to.id, expiresAt);

  markInvitation(db, invitation.id, 'declined');

  const found = findInvitationById(db, invitation.id);
  assert.ok(found);
  assert.equal(found.status, 'declined');
  db.close();
});

test('deleteInvitationsForRoom supprime celles de ce salon et laisse celles des autres', () => {
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  const expiresAt = new Date(T0.getTime() + 600_000);
  const inRoom1 = createInvitation(db, 'room-1', from.id, to.id, expiresAt);
  const inRoom2 = createInvitation(db, 'room-2', from.id, to.id, expiresAt);

  deleteInvitationsForRoom(db, 'room-1');

  assert.equal(findInvitationById(db, inRoom1.id), null);
  assert.ok(findInvitationById(db, inRoom2.id));
  db.close();
});

test('une invitation survit à la disparition du salon qu elle désigne', () => {
  // La table n'a délibérément pas de clé étrangère sur roomId : les salons
  // vivent dans une Map en mémoire, pas en base, donc il n'y a rien à
  // référencer. Ce test fixe ce comportement pour que personne ne "corrige"
  // en ajoutant une contrainte impossible.
  const db = migratedDb();
  const from = insertUser(db);
  const to = insertUser(db);
  const expiresAt = new Date(T0.getTime() + 600_000);

  const invitation = createInvitation(db, 'room-vanished', from.id, to.id, expiresAt);
  // Rien ne supprime le salon en base puisqu'il n'y a jamais été : l'absence
  // de contrainte se vérifie simplement en relisant l'invitation.

  const found = findInvitationById(db, invitation.id);
  assert.ok(found);
  assert.equal(found.roomId, 'room-vanished');
  db.close();
});
