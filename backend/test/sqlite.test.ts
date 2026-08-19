import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, databaseFileFromUrl } from '../src/db/sqlite.js';

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'psnes-db-'));
  return join(dir, name);
}

test('databaseFileFromUrl strips the file: prefix Prisma used', () => {
  assert.equal(databaseFileFromUrl('file:/app/data/dev.db'), '/app/data/dev.db');
  assert.equal(databaseFileFromUrl('file:./prisma/data/dev.db'), './prisma/data/dev.db');
});

test('databaseFileFromUrl accepts a bare path', () => {
  assert.equal(databaseFileFromUrl('/app/data/dev.db'), '/app/data/dev.db');
});

test('openDatabase enforces foreign keys, so cascades actually cascade', () => {
  const file = tempFile('fk.db');
  const db = openDatabase(file);

  db.exec(`
    CREATE TABLE parent (id TEXT PRIMARY KEY);
    CREATE TABLE child (
      id TEXT PRIMARY KEY,
      parentId TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE
    );
  `);
  db.prepare(`INSERT INTO parent (id) VALUES ('p')`).run();
  db.prepare(`INSERT INTO child (id, parentId) VALUES ('c', 'p')`).run();

  db.prepare(`DELETE FROM parent WHERE id = 'p'`).run();

  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM child`).get() as { n: number };
  assert.equal(remaining.n, 0, 'the child row should have been cascaded away');

  db.close();
  rmSync(file, { force: true });
});

test('openDatabase uses WAL, so a reader never blocks the writer', () => {
  const file = tempFile('wal.db');
  const db = openDatabase(file);
  const mode = db.pragma('journal_mode', { simple: true });
  assert.equal(mode, 'wal');
  db.close();
  rmSync(file, { force: true });
});
