import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/sqlite.js';
import { migrate, SchemaDriftError } from '../src/db/migrate.js';

const BASELINE = `CREATE TABLE "Widget" ("id" TEXT NOT NULL PRIMARY KEY, "label" TEXT NOT NULL);`;
const SECOND = `ALTER TABLE "Widget" ADD COLUMN "colour" TEXT;`;

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'psnes-mig-'));
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, 'migrations', name), body);
  }
  return join(dir, 'migrations');
}

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'psnes-mig-db-'));
  return openDatabase(join(dir, 'test.db'));
}

test('an empty database gets every migration applied in order', () => {
  const dir = fixture({ '0001_baseline.sql': BASELINE, '0002_colour.sql': SECOND });
  const db = freshDb();

  const result = migrate(db, dir);

  assert.deepEqual(result.applied, ['0001_baseline.sql', '0002_colour.sql']);
  assert.deepEqual(result.baselined, []);
  const cols = db.prepare(`PRAGMA table_info('Widget')`).all() as { name: string }[];
  assert.deepEqual(cols.map(c => c.name), ['id', 'label', 'colour']);
  db.close();
});

test('running twice applies nothing the second time', () => {
  const dir = fixture({ '0001_baseline.sql': BASELINE, '0002_colour.sql': SECOND });
  const db = freshDb();

  migrate(db, dir);
  const second = migrate(db, dir);

  assert.deepEqual(second.applied, []);
  db.close();
});

test('an existing database matching the baseline is recorded, not re-run', () => {
  const dir = fixture({ '0001_baseline.sql': BASELINE });
  const db = freshDb();
  // Stand in for a database Prisma built: the schema is there, our bookkeeping
  // table is not.
  db.exec(BASELINE);
  db.exec(`CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY)`);

  const result = migrate(db, dir);

  assert.deepEqual(result.baselined, ['0001_baseline.sql']);
  assert.deepEqual(result.applied, []);
});

test('an existing database that has drifted refuses to start', () => {
  const dir = fixture({ '0001_baseline.sql': BASELINE });
  const db = freshDb();
  // One column short of what the baseline produces - exactly the drift #7
  // warned would otherwise be frozen where nobody looks.
  db.exec(`CREATE TABLE "Widget" ("id" TEXT NOT NULL PRIMARY KEY)`);
  db.exec(`CREATE TABLE "_prisma_migrations" ("id" TEXT PRIMARY KEY)`);

  assert.throws(
    () => migrate(db, dir),
    (err: unknown) => {
      assert.ok(err instanceof SchemaDriftError);
      assert.ok(err.differences.length > 0, 'the error should say what differs');
      assert.ok(err.differences.join('\n').includes('Widget'));
      return true;
    }
  );
});

test('after baselining, later migrations still apply', () => {
  const dir = fixture({ '0001_baseline.sql': BASELINE, '0002_colour.sql': SECOND });
  const db = freshDb();
  db.exec(BASELINE);

  const result = migrate(db, dir);

  assert.deepEqual(result.baselined, ['0001_baseline.sql']);
  assert.deepEqual(result.applied, ['0002_colour.sql']);
  const cols = db.prepare(`PRAGMA table_info('Widget')`).all() as { name: string }[];
  assert.ok(cols.some(c => c.name === 'colour'));
});

test('a failing migration leaves the database untouched', () => {
  const dir = fixture({
    '0001_baseline.sql': BASELINE,
    '0002_broken.sql': `ALTER TABLE "Nope" ADD COLUMN "x" TEXT;`
  });
  const db = freshDb();

  assert.throws(() => migrate(db, dir));

  const recorded = db.prepare(`SELECT name FROM schema_migrations`).all() as { name: string }[];
  assert.deepEqual(recorded.map(r => r.name), ['0001_baseline.sql']);
});
