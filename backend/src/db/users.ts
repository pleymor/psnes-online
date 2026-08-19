import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { User, UserSummary } from './types.js';

interface UserRow {
  id: string;
  googleId: string;
  email: string;
  displayName: string;
  avatar: string | null;
  controlsConfig: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The one place a User row becomes a User. */
function toUser(row: UserRow): User {
  return {
    id: row.id,
    googleId: row.googleId,
    email: row.email,
    displayName: row.displayName,
    avatar: row.avatar,
    controlsConfig: row.controlsConfig,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}

const SELECT = `SELECT * FROM "User"`;

export function findUserById(db: Database, id: string): User | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function findUserByGoogleId(db: Database, googleId: string): User | null {
  const row = db.prepare(`${SELECT} WHERE googleId = ?`).get(googleId) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function findUserByEmail(db: Database, email: string): User | null {
  const row = db.prepare(`${SELECT} WHERE email = ?`).get(email) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function createUser(
  db: Database,
  input: { googleId: string; email: string; displayName: string; avatar: string | null }
): User {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO "User" (id, googleId, email, displayName, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(id, input.googleId, input.email, input.displayName, input.avatar, now, now);
  return findUserById(db, id)!;
}

export function updateUserProfile(
  db: Database,
  id: string,
  input: { displayName: string; avatar: string | null }
): User {
  db.prepare(`
    UPDATE "User" SET displayName = ?, avatar = ?, updatedAt = ? WHERE id = ?
  `).run(input.displayName, input.avatar, Date.now(), id);
  return findUserById(db, id)!;
}

/**
 * The dev-login shortcut. Creates the fixed dev user, or refreshes nothing but
 * its avatar - matching what the Prisma upsert did.
 */
export function upsertDevUser(
  db: Database,
  input: { id: string; googleId: string; email: string; displayName: string; avatar: string }
): User {
  const now = Date.now();
  db.prepare(`
    INSERT INTO "User" (id, googleId, email, displayName, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (@id, @googleId, @email, @displayName, @avatar, NULL, @now, @now)
    ON CONFLICT(id) DO UPDATE SET avatar = @avatar, updatedAt = @now
  `).run({ ...input, now });
  return findUserById(db, input.id)!;
}

export function findControlsConfig(db: Database, userId: string): string | null {
  const row = db.prepare(`SELECT controlsConfig FROM "User" WHERE id = ?`)
    .get(userId) as { controlsConfig: string | null } | undefined;
  return row?.controlsConfig ?? null;
}

/**
 * Unlike Prisma, which threw P2025 for a row that had vanished, a `WHERE id
 * = ?` matching nothing here silently affects zero rows - a deliberate
 * decision, not an oversight, made the same way across the five other writes
 * of this shape (updateSaveData, updateGameMetadata, deleteGame,
 * deleteFriendship, saveSram), each already guarded by an existence or
 * ownership check; its one caller-visible effect is that `PUT /controls` and
 * `POST /controls/reset` now return 200 instead of 500 for a user whose row
 * is gone.
 */
export function updateControlsConfig(db: Database, userId: string, json: string): void {
  db.prepare(`UPDATE "User" SET controlsConfig = ?, updatedAt = ? WHERE id = ?`)
    .run(json, Date.now(), userId);
}

/**
 * Friend suggestions. Returns only what the client is allowed to see - never
 * googleId, never the timestamps - which the old `select:` clause guaranteed
 * and a `SELECT *` would quietly give away.
 */
export function searchUsers(
  db: Database,
  excludeUserId: string,
  query: string,
  limit: number
): UserSummary[] {
  return db.prepare(`
    SELECT id, email, displayName, avatar FROM "User"
    WHERE id != ?
      AND (email LIKE '%' || ? || '%' OR displayName LIKE '%' || ? || '%')
    LIMIT ?
  `).all(excludeUserId, query, query, limit) as UserSummary[];
}
