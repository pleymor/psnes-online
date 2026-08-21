import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { InvitationStatus } from '../rooms/invitation-state.js';

export interface Invitation {
  id: string;
  roomId: string;
  fromUserId: string;
  toUserId: string;
  status: InvitationStatus;
  createdAt: Date;
  expiresAt: Date;
}

interface InvitationRow {
  id: string;
  roomId: string;
  fromUserId: string;
  toUserId: string;
  status: string;
  // Des NOMBRES : ce dépôt stocke les dates en millisecondes epoch. Voir
  // `FriendshipRow` dans friendships.ts, qui déclare `createdAt: number` et
  // écrit `Date.now()`. Déclarer `string` ici typecheckerait sans broncher et
  // produirait une comparaison de temps fausse en silence.
  createdAt: number;
  expiresAt: number;
}

/**
 * Les repasser en `Date` ici et nulle part ailleurs : `invitationState`
 * compare des instants, et un nombre ou une chaîne qui lui arrive à la place
 * d'une `Date` donne une comparaison silencieusement fausse plutôt qu'une
 * erreur.
 */
function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    roomId: row.roomId,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    status: row.status as InvitationStatus,
    createdAt: new Date(row.createdAt),
    expiresAt: new Date(row.expiresAt)
  };
}

export function createInvitation(
  db: Database, roomId: string, fromUserId: string, toUserId: string, expiresAt: Date
): Invitation {
  const id = randomUUID();
  // `createdAt` est écrit EXPLICITEMENT, jamais laissé au DEFAULT
  // CURRENT_TIMESTAMP de la table : ce défaut insérerait du texte là où tout
  // le reste du dépôt met des millisecondes epoch, et SQLite étant typé
  // dynamiquement personne ne s'en plaindrait avant que la comparaison de
  // dates soit fausse.
  db.prepare(
    `INSERT INTO "RoomInvitation" (id, roomId, fromUserId, toUserId, status, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, roomId, fromUserId, toUserId, Date.now(), expiresAt.getTime());
  const created = findInvitationById(db, id);
  if (!created) throw new Error('the invitation vanished between insert and read');
  return created;
}

export function findInvitationById(db: Database, id: string): Invitation | null {
  const row = db.prepare(`SELECT * FROM "RoomInvitation" WHERE id = ?`)
    .get(id) as InvitationRow | undefined;
  return row ? toInvitation(row) : null;
}

/** Les invitations encore en attente pour ce joueur, les plus récentes d'abord. */
export function listPendingInvitationsFor(db: Database, userId: string): Invitation[] {
  const rows = db.prepare(
    `SELECT * FROM "RoomInvitation" WHERE toUserId = ? AND status = 'pending' ORDER BY createdAt DESC`
  ).all(userId) as InvitationRow[];
  return rows.map(toInvitation);
}

/**
 * Redonne son plein délai à une invitation réutilisée.
 *
 * Réinviter est la façon d'atteindre un ami qui était hors ligne il y a une
 * minute : on garde une seule ligne, mais lui rendre les restes du premier
 * délai n'est pas une invitation.
 */
export function refreshInvitationDeadline(db: Database, id: string, expiresAt: Date): Invitation {
  db.prepare(`UPDATE "RoomInvitation" SET expiresAt = ? WHERE id = ?`)
    .run(expiresAt.getTime(), id);
  const refreshed = findInvitationById(db, id);
  if (!refreshed) throw new Error('the invitation vanished while its deadline moved');
  return refreshed;
}

export function markInvitation(db: Database, id: string, status: InvitationStatus): void {
  db.prepare(`UPDATE "RoomInvitation" SET status = ? WHERE id = ?`).run(status, id);
}

/** Appelée quand un salon meurt : ses invitations n'ont plus de cible. */
export function deleteInvitationsForRoom(db: Database, roomId: string): void {
  db.prepare(`DELETE FROM "RoomInvitation" WHERE roomId = ?`).run(roomId);
}

/**
 * Le balayage du démarrage : les lignes dont le délai est passé.
 *
 * Un salon qui meurt proprement emporte ses invitations
 * (`deleteInvitationsForRoom`), mais un crash ou un `kill -9` les laisse
 * derrière lui sans personne pour les supprimer. La justesse n'en a jamais
 * dépendu — `lobby:accept` et la livraison à la connexion vérifient tous deux
 * que le salon existe encore — donc ceci ne sert qu'à ce que la table ne
 * grossisse pas indéfiniment.
 *
 * La borne est le même `<=` que celui d'`invitationState` : une invitation
 * expirée pour un lecteur est expirée pour le balayage, sans fenêtre où les
 * deux se contrediraient. Et `now` est un paramètre pour la même raison.
 */
export function deleteExpiredInvitations(db: Database, now: Date): number {
  return db.prepare(`DELETE FROM "RoomInvitation" WHERE expiresAt <= ?`)
    .run(now.getTime()).changes;
}
