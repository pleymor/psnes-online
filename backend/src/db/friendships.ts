import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { Friendship, PublicUser } from './types.js';

export interface FriendshipWithProfiles extends Friendship {
  initiator: PublicUser;
  receiver: PublicUser;
}

export interface FriendshipWithInitiator extends Friendship {
  initiator: PublicUser;
}

interface FriendshipRow {
  id: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  initiatorId: string;
  receiverId: string;
}

function toFriendship(row: FriendshipRow): Friendship {
  return {
    id: row.id,
    status: row.status,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    initiatorId: row.initiatorId,
    receiverId: row.receiverId
  };
}

/**
 * The joins used to come back as nested objects, and the callers read them that
 * way - `f.initiator.pseudo`. A flat row would mean changing every caller, so
 * the nesting is rebuilt here instead, once.
 *
 * Columns are aliased with a prefix rather than selected as `u.*`, because
 * User and Friendship both have `id`, `createdAt` and `updatedAt`.
 *
 * These four columns are the whole of PublicUser, and that is the point. This
 * used to select all eight, so every friend received your googleId, your email
 * and your controlsConfig - api/friends.ts handed the object straight to the
 * wire. Narrowing it at the source rather than at each caller is what makes
 * the guarantee hold by typing: a route cannot leak a field this query never
 * fetched. backend/test/friendships.test.ts asserts the exact key set, because
 * the failure mode to fear is a field reappearing, not one going missing.
 */
const USER_COLUMNS = (alias: string, prefix: string) => `
  ${alias}.id AS ${prefix}_id,
  ${alias}.pseudo AS ${prefix}_pseudo,
  ${alias}.discriminator AS ${prefix}_discriminator,
  ${alias}.avatar AS ${prefix}_avatar
`;

function toUserFrom(row: Record<string, unknown>, prefix: string): PublicUser {
  return {
    id: row[`${prefix}_id`] as string,
    pseudo: row[`${prefix}_pseudo`] as string,
    discriminator: row[`${prefix}_discriminator`] as string,
    avatar: (row[`${prefix}_avatar`] as string | null) ?? null
  };
}

function toFriendshipBase(row: Record<string, unknown>): Friendship {
  return toFriendship({
    id: row.id as string,
    status: row.status as string,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    initiatorId: row.initiatorId as string,
    receiverId: row.receiverId as string
  });
}

const BOTH_PROFILES = `
  SELECT f.*,
    ${USER_COLUMNS('i', 'i')},
    ${USER_COLUMNS('r', 'r')}
  FROM "Friendship" f
  JOIN "User" i ON i.id = f.initiatorId
  JOIN "User" r ON r.id = f.receiverId
`;

function toWithProfiles(row: Record<string, unknown>): FriendshipWithProfiles {
  return {
    ...toFriendshipBase(row),
    initiator: toUserFrom(row, 'i'),
    receiver: toUserFrom(row, 'r')
  };
}

export function listAcceptedFriendshipsFor(db: Database, userId: string): Friendship[] {
  const rows = db.prepare(`
    SELECT * FROM "Friendship"
    WHERE (initiatorId = ? OR receiverId = ?) AND status = 'accepted'
  `).all(userId, userId) as FriendshipRow[];
  return rows.map(toFriendship);
}

export function listAcceptedFriendshipsWithProfiles(
  db: Database,
  userId: string
): FriendshipWithProfiles[] {
  const rows = db.prepare(`
    ${BOTH_PROFILES}
    WHERE (f.initiatorId = ? OR f.receiverId = ?) AND f.status = 'accepted'
  `).all(userId, userId) as Record<string, unknown>[];
  return rows.map(toWithProfiles);
}

export function listPendingRequestsFor(db: Database, userId: string): FriendshipWithInitiator[] {
  const rows = db.prepare(`
    SELECT f.*, ${USER_COLUMNS('i', 'i')}
    FROM "Friendship" f
    JOIN "User" i ON i.id = f.initiatorId
    WHERE f.receiverId = ? AND f.status = 'pending'
  `).all(userId) as Record<string, unknown>[];
  return rows.map(row => ({ ...toFriendshipBase(row), initiator: toUserFrom(row, 'i') }));
}

export function listFriendshipPairsFor(
  db: Database,
  userId: string
): { initiatorId: string; receiverId: string; status: string }[] {
  return db.prepare(`
    SELECT initiatorId, receiverId, status FROM "Friendship"
    WHERE initiatorId = ? OR receiverId = ?
  `).all(userId, userId) as { initiatorId: string; receiverId: string; status: string }[];
}

export function findFriendshipById(db: Database, id: string): Friendship | null {
  const row = db.prepare(`SELECT * FROM "Friendship" WHERE id = ?`).get(id) as FriendshipRow | undefined;
  return row ? toFriendship(row) : null;
}

export function findFriendshipBetween(db: Database, a: string, b: string): Friendship | null {
  const row = db.prepare(`
    SELECT * FROM "Friendship"
    WHERE (initiatorId = ? AND receiverId = ?) OR (initiatorId = ? AND receiverId = ?)
  `).get(a, b, b, a) as FriendshipRow | undefined;
  return row ? toFriendship(row) : null;
}

function findWithProfiles(db: Database, id: string): FriendshipWithProfiles {
  const row = db.prepare(`${BOTH_PROFILES} WHERE f.id = ?`).get(id) as Record<string, unknown>;
  return toWithProfiles(row);
}

export function createFriendshipRequest(
  db: Database,
  initiatorId: string,
  receiverId: string
): FriendshipWithProfiles {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO "Friendship" (id, status, createdAt, updatedAt, initiatorId, receiverId)
    VALUES (?, 'pending', ?, ?, ?, ?)
  `).run(id, now, now, initiatorId, receiverId);
  return findWithProfiles(db, id);
}

export function acceptFriendship(db: Database, id: string): FriendshipWithProfiles {
  db.prepare(`UPDATE "Friendship" SET status = 'accepted', updatedAt = ? WHERE id = ?`)
    .run(Date.now(), id);
  return findWithProfiles(db, id);
}

export function deleteFriendship(db: Database, id: string): void {
  db.prepare(`DELETE FROM "Friendship" WHERE id = ?`).run(id);
}
