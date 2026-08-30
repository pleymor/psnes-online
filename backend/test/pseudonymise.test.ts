/**
 * The one statement in this repository that runs exactly once, in production,
 * against real people's rows.
 *
 * helpers.ts:migratedDb() starts from an empty database, so the backfill in
 * 0004_pseudonymous_users.sql would touch zero rows there and the whole suite
 * would pass without ever executing it. This file builds the real path
 * instead: the actual 0001-0003 files, real rows carrying emails and Google
 * names, and only then the actual 0004.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase, type Database } from '../src/db/sqlite.js';
import { migrate } from '../src/db/migrate.js';

const REAL_MIGRATIONS = resolve(import.meta.dirname, '../migrations');
const BEFORE = ['0001_baseline.sql', '0002_room_invitations.sql', '0003_community_metadata.sql'];
const SUBJECT = '0004_pseudonymous_users.sql';

/** A migrations directory holding real files, copied so we control the cut-off. */
function stagedMigrations(files: string[]): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'psnes-pseudo-')), 'migrations');
  mkdirSync(dir, { recursive: true });
  for (const name of files) copyFileSync(join(REAL_MIGRATIONS, name), join(dir, name));
  return dir;
}

function freshDb(): Database {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'psnes-pseudo-db-')), 'test.db'));
}

/**
 * A database as it stood before this migration: schema at 0003, populated with
 * the personal data the migration exists to remove.
 */
function populatedAt0003(count: number): { db: Database; dir: string } {
  const dir = stagedMigrations(BEFORE);
  const db = freshDb();
  migrate(db, dir);

  const insert = db.prepare(`
    INSERT INTO "User" (id, googleId, email, displayName, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
  `);
  // createdAt ascends with the index so the ROW_NUMBER() ordering in the
  // migration has something unambiguous to sort on.
  for (let i = 1; i <= count; i++) {
    insert.run(`user-${i}`, `google-${i}`, `person${i}@example.test`, `Jean Dupont ${i}`, 1_700_000_000_000 + i, 1_700_000_000_000 + i);
  }

  return { db, dir };
}

/** Applies the subject migration to a directory already staged at 0003. */
function applySubject(db: Database, dir: string): void {
  copyFileSync(join(REAL_MIGRATIONS, SUBJECT), join(dir, SUBJECT));
  migrate(db, dir);
}

function handles(db: Database): string[] {
  return (db.prepare(`SELECT pseudo, discriminator FROM "User" ORDER BY createdAt, id`)
    .all() as { pseudo: string; discriminator: string }[])
    .map(r => `${r.pseudo}#${r.discriminator}`);
}

test('every existing account comes out with a pseudonym and a four-digit discriminator', () => {
  const { db, dir } = populatedAt0003(40);
  applySubject(db, dir);

  const rows = db.prepare(`SELECT pseudo, discriminator FROM "User"`)
    .all() as { pseudo: string; discriminator: string }[];

  assert.equal(rows.length, 40);
  for (const row of rows) {
    assert.match(row.pseudo, /^[A-Za-z0-9_-]{3,16}$/, 'a backfilled pseudonym must satisfy the format rule');
    assert.match(row.discriminator, /^\d{4}$/, 'the padding is part of the value');
  }
});

test('no two accounts come out with the same handle', () => {
  const { db, dir } = populatedAt0003(40);
  applySubject(db, dir);

  const distinct = db.prepare(
    `SELECT COUNT(DISTINCT pseudo || '#' || discriminator) AS c FROM "User"`
  ).get() as { c: number };

  assert.equal(distinct.c, 40, 'uniqueness observed, not assumed');
});

test('nobody is treated as having chosen their pseudonym', () => {
  const { db, dir } = populatedAt0003(40);
  applySubject(db, dir);

  const chosen = db.prepare(`SELECT COUNT(*) AS c FROM "User" WHERE pseudoChosenAt IS NOT NULL`)
    .get() as { c: number };

  assert.equal(chosen.c, 0, 'a NULL pseudoChosenAt is what opens the onboarding gate');
});

test('the personal columns are gone from the table, not merely blanked', () => {
  const { db, dir } = populatedAt0003(3);
  applySubject(db, dir);

  // bun:sqlite exposes the column names as a property, where
  // better-sqlite3 had `.columns()` returning descriptor objects.
  const columns = db.prepare(`SELECT * FROM "User" LIMIT 0`).columnNames;

  assert.ok(!columns.includes('email'), 'email should no longer be a column');
  assert.ok(!columns.includes('displayName'), 'displayName should no longer be a column');
  assert.ok(columns.includes('pseudo'), 'and pseudo should have taken its place');
  assert.ok(columns.includes('googleId'), 'googleId stays: it is the OAuth join key');
});

test('the seventeenth account wraps onto the second discriminator', () => {
  // This is the assertion that catches an off-by-one in `n / 16 + 1`, the
  // expression in the migration most likely to be written wrong.
  const { db, dir } = populatedAt0003(17);
  applySubject(db, dir);

  const all = handles(db);
  assert.equal(all[0], 'Sprite#0001', 'the first word, the first discriminator');
  assert.equal(all[15], 'Cathode#0001', 'the sixteenth word still on the first');
  assert.equal(all[16], 'Sprite#0002', 'the seventeenth wraps to the first word, second discriminator');
});

test('the same input produces the same assignment twice', () => {
  const first = populatedAt0003(20);
  applySubject(first.db, first.dir);

  const second = populatedAt0003(20);
  applySubject(second.db, second.dir);

  assert.deepEqual(handles(first.db), handles(second.db),
    'ROW_NUMBER() OVER (ORDER BY createdAt, id) is deterministic, or it is not');
});

test('the unique index folds case, so Sprite#0001 blocks sprite#0001', () => {
  const { db, dir } = populatedAt0003(1);
  applySubject(db, dir);

  assert.throws(
    () => db.prepare(`
      INSERT INTO "User" (id, googleId, avatar, controlsConfig, createdAt, updatedAt, pseudo, discriminator)
      VALUES ('intruder', 'google-x', NULL, NULL, 1, 1, 'sprite', '0001')
    `).run(),
    (err: { code?: string }) => err.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
});

test('running the migration a second time is a no-op, not a re-backfill', () => {
  const { db, dir } = populatedAt0003(5);
  applySubject(db, dir);
  const before = handles(db);

  const result = migrate(db, dir);

  assert.deepEqual(result.applied, [], 'the ledger should already carry every file');
  assert.deepEqual(handles(db), before);
});
