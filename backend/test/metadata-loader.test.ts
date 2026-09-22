import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase, getDb, forgetDbForTest } from '../src/db/sqlite.js';
import { migrate } from '../src/db/migrate.js';
import { countGameMetadata, listGameMetadata } from '../src/db/game-metadata.js';
import { refreshGameMetadata, findGameMetadata } from '../src/services/metadata-loader.js';

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
// `bun test` runs every file in one process, so the getDb() singleton may
// already be holding another file's (closed) handle. See forgetDbForTest.
forgetDbForTest();
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

/*
 * Ce que `findGameMetadata` répond, épinglé avant de changer comment il le
 * trouve.
 *
 * Il balayait le catalogue deux fois en renormalisant chaque fiche à chaque
 * passage ; il lit maintenant l'index de `catalogue-index.ts`. Ces tests ne
 * décrivent donc aucune nouveauté - ils décrivent la réponse d'AVANT, pour
 * qu'un changement silencieux soit impossible. Ce qui se joue derrière est la
 * fiche qu'un dump se voit attribuer : une autre, et le joueur hérite du
 * mauvais titre, de la mauvaise jaquette et du mauvais classement.
 */

test('un nom de fichier retrouve la fiche par son titre normalisé', async () => {
  await refreshGameMetadata(writeCatalogue([{ title: 'Super Metroid' }]));

  const found = await findGameMetadata('Super Metroid (USA).sfc');

  assert.equal(found?.title, 'Super Metroid');
});

test("l'alt-titre retrouve la fiche aussi", async () => {
  await refreshGameMetadata(writeCatalogue([
    { title: 'ActRaiser', altTitle: 'アクトレイザー' }
  ]));

  assert.equal((await findGameMetadata('アクトレイザー'))?.title, 'ActRaiser');
});

test('la correspondance exacte passe devant une simple mention, où qu\'elle soit', async () => {
  // L'ancienne forme faisait la passe exacte sur TOUT le catalogue avant
  // d'essayer la passe partielle. La mention vient en premier dans le
  // catalogue et doit quand même perdre.
  await refreshGameMetadata(writeCatalogue([
    { title: 'The Legend of Super Metroid' },
    { title: 'Super Metroid' }
  ]));

  assert.equal((await findGameMetadata('Super Metroid'))?.title, 'Super Metroid');
});

test("à défaut d'exact, une correspondance partielle fait l'affaire", async () => {
  await refreshGameMetadata(writeCatalogue([{ title: 'Super Metroid Redux' }]));

  assert.equal((await findGameMetadata('Super Metroid'))?.title, 'Super Metroid Redux');
});

test('un titre que le catalogue ne connaît pas rend null', async () => {
  await refreshGameMetadata(writeCatalogue([{ title: 'Super Metroid' }]));

  assert.equal(await findGameMetadata('Pilotwings'), null);
});

test('à titre normalisé identique, la première fiche du catalogue gagne', async () => {
  await refreshGameMetadata(writeCatalogue([
    { title: 'Super Metroid', crc32: 'AAAAAAAA' },
    { title: 'Super Metroid (USA)', crc32: 'BBBBBBBB' }
  ]));

  assert.equal((await findGameMetadata('Super Metroid'))?.crc32, 'AAAAAAAA');
});

test('un catalogue rafraîchi est vu tout de suite', async () => {
  // Le garde du cache d'index : il est claveté sur le TABLEAU rendu par
  // `cachedCatalogue`, et un rafraîchissement en fabrique un neuf. Si jamais
  // l'index se mettait à survivre à son catalogue, c'est ici que ça se verrait.
  await refreshGameMetadata(writeCatalogue([{ title: 'Super Metroid' }]));
  assert.equal((await findGameMetadata('Super Metroid'))?.title, 'Super Metroid');

  await refreshGameMetadata(writeCatalogue([{ title: 'Pilotwings' }]));

  assert.equal(await findGameMetadata('Super Metroid'), null);
  assert.equal((await findGameMetadata('Pilotwings'))?.title, 'Pilotwings');
});
