import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase, getDb } from '../src/db/sqlite.js';
import { migrate } from '../src/db/migrate.js';
import { countGameMetadata, listGameMetadata } from '../src/db/game-metadata.js';
import { refreshGameMetadata } from '../src/services/metadata-loader.js';

/**
 * `refreshGameMetadata` reads `DATABASE_URL` through the same `getDb()`
 * singleton the rest of the app uses, so - unlike every other repository test
 * in this directory, which builds its own throwaway `Database` - this file
 * has to point that singleton at a temp file before the service ever touches
 * it. One connection sets up the schema and is closed again; `getDb()` then
 * opens its own connection to the same file, exactly as it would in the app.
 */
const dir = mkdtempSync(join(tmpdir(), 'psnes-metadata-loader-'));
const dbFile = join(dir, 'test.db');

const setupDb = openDatabase(dbFile);
migrate(setupDb, resolve(import.meta.dirname, '../migrations'));
setupDb.close();

process.env.DATABASE_URL = `file:${dbFile}`;
const db = getDb();

const GOOD_ENTRY = { title: 'Super Metroid', crc32: 'D63ED5F8', md5: 'abc123' };

function writeCatalogue(entries: unknown): string {
  const file = join(dir, `${randomSuffix()}.json`);
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

let counter = 0;
function randomSuffix(): string {
  counter += 1;
  return `catalogue-${counter}`;
}

test('a refresh loads a fresh catalogue into an empty table', async () => {
  await refreshGameMetadata(writeCatalogue([GOOD_ENTRY]));

  assert.equal(countGameMetadata(db), 1);
  assert.equal(listGameMetadata(db)[0].title, 'Super Metroid');
});

test('a refresh whose file cannot be parsed leaves the previous catalogue intact', async () => {
  await refreshGameMetadata(writeCatalogue([GOOD_ENTRY]));
  assert.equal(countGameMetadata(db), 1);

  const brokenFile = join(dir, 'broken.json');
  writeFileSync(brokenFile, '{ this is not valid json');

  await refreshGameMetadata(brokenFile);

  assert.equal(countGameMetadata(db), 1,
    'a JSON parse failure must not leave the table empty between the delete and the insert');
  assert.equal(listGameMetadata(db)[0].title, 'Super Metroid');
});

test('a refresh whose file is missing leaves the previous catalogue intact', async () => {
  await refreshGameMetadata(writeCatalogue([GOOD_ENTRY]));
  assert.equal(countGameMetadata(db), 1);

  await refreshGameMetadata(join(dir, 'does-not-exist.json'));

  assert.equal(countGameMetadata(db), 1);
  assert.equal(listGameMetadata(db)[0].title, 'Super Metroid');
});

test('a refresh whose batch insert fails partway through leaves the previous catalogue intact', async () => {
  await refreshGameMetadata(writeCatalogue([GOOD_ENTRY]));
  assert.equal(countGameMetadata(db), 1);

  // "title" is NOT NULL: the second entry breaks the whole batch. This is the
  // scenario the fix is for - without one transaction around the delete and
  // the insert, the table is left empty here instead of rolled back.
  const entries = [
    { title: 'A Working Game', crc32: 'AAA' },
    { title: null, crc32: 'BBB' }
  ];

  await refreshGameMetadata(writeCatalogue(entries));

  assert.equal(countGameMetadata(db), 1,
    'a mid-batch failure must roll back to the previous catalogue, not an empty table');
  assert.equal(listGameMetadata(db)[0].title, 'Super Metroid');
});
