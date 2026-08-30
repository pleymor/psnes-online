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

/**
 * A serial number, so every helper-made account gets a handle of its own.
 *
 * The unique index on (pseudo COLLATE NOCASE, discriminator) is real, so two
 * users built from the same defaults would collide. Counting is preferable to
 * drawing at random here: a test that fails once in a thousand runs because
 * two draws matched is worse than no test.
 */
let serial = 0;

export function insertUser(
  db: Database,
  over: Partial<{
    id: string;
    googleId: string;
    pseudo: string;
    discriminator: string;
    pseudoChosenAt: number | null;
    avatar: string | null;
    isAnonymous: number;
  }> = {}
) {
  const now = Date.now();
  const n = serial++;
  const row = {
    id: over.id ?? `user-${now}-${n}`,
    googleId: over.googleId ?? `g-${now}-${n}`,
    pseudo: over.pseudo ?? 'Tester',
    discriminator: over.discriminator ?? String(n % 10000).padStart(4, '0'),
    pseudoChosenAt: over.pseudoChosenAt === undefined ? now : over.pseudoChosenAt,
    avatar: over.avatar ?? null,
    isAnonymous: over.isAnonymous ?? 0
  };
  db.prepare(`
    INSERT INTO "User" (id, googleId, isAnonymous, pseudo, discriminator, pseudoChosenAt, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (@id, @googleId, @isAnonymous, @pseudo, @discriminator, @pseudoChosenAt, @avatar, NULL, @now, @now)
  `).run({ ...row, now });
  return row;
}
