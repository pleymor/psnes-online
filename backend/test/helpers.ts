import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase, type Database } from '../src/db/sqlite.js';
import { migrate } from '../src/db/migrate.js';

/**
 * A real database on a real file, migrated from the real baseline. Nothing is
 * mocked: these tests are the only thing standing between 50 rewritten queries
 * and production.
 */
export function migratedDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), 'psnes-repo-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db, resolve(import.meta.dirname, '../migrations'));
  return db;
}

export function insertUser(db: Database, over: Partial<{ id: string; googleId: string; email: string; displayName: string; avatar: string | null }> = {}) {
  const now = Date.now();
  const row = {
    id: over.id ?? `user-${Math.floor(now * Math.random())}`,
    googleId: over.googleId ?? `g-${Math.floor(now * Math.random())}`,
    email: over.email ?? `u${Math.floor(now * Math.random())}@example.test`,
    displayName: over.displayName ?? 'Test User',
    avatar: over.avatar ?? null
  };
  db.prepare(`
    INSERT INTO "User" (id, googleId, email, displayName, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (@id, @googleId, @email, @displayName, @avatar, NULL, @now, @now)
  `).run({ ...row, now });
  return row;
}
