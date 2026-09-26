/**
 * Les routes de la file de sauvegardes (#71), par HTTP, sur une vraie base.
 *
 * Le routeur est monté seul dans une application Express qui écoute sur un
 * port libre ; seule la session est remplacée - un en-tête dit qui appelle,
 * ce que `passport` ferait à partir du cookie. La règle de fusion a ses
 * propres tests (`sync-plan.test.ts`) ; ceux-ci prouvent ce que la route
 * ajoute : la garde du compte, le checksum qui désigne la ligne du joueur,
 * l'envoi rejoué qui ne double rien, et qu'un conflit garde les deux côtés
 * en base.
 */

import { test, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

const dir = mkdtempSync(join(tmpdir(), 'psnes-sync-api-'));
process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`;

const { default: express } = await import('express');
const { getDb, forgetDbForTest } = await import('../src/db/sqlite.js');
const { migrate } = await import('../src/db/migrate.js');
const { syncRouter } = await import('../src/api/sync.js');
const { createGame, saveSram } = await import('../src/db/games.js');
const { insertUser } = await import('./helpers.js');

forgetDbForTest();
const db = getDb();
migrate(db, resolve(import.meta.dirname, '../migrations'));

const app = express();
app.use('/api/sync', express.json({ limit: '8mb' }));
app.use((req, _res, next) => {
  const id = req.header('x-user');
  if (id) (req as unknown as { user: unknown }).user = { id, isAnonymous: false };
  next();
});
app.use('/api/sync', syncRouter);
const server = app.listen(0);
await new Promise<void>(done => server.once('listening', () => done()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sync`;

afterAll(() => {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const NO_METADATA = {
  genre: null, publisher: null, developer: null, releaseDate: null,
  players: null, region: null, description: null, coverUrl: null
};

let crcSerial = 0x10000000;
function aPlayerWithAGame() {
  const user = insertUser(db);
  const crc32 = (crcSerial++).toString(16).toUpperCase();
  const game = createGame(db, { title: 'G', filename: 'G.sfc', crc32, userId: user.id, ...NO_METADATA });
  return { user, crc32, game };
}

const b64 = (...b: number[]) => Buffer.from(b).toString('base64');
let syncSerial = 0;
const syncId = () => `sync-${Date.now()}-${syncSerial++}`;

async function call(method: string, path: string, user: string | null, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json().catch(() => null) };
}

function savesOf(gameId: string) {
  return db.query(`SELECT name, kind, data, updatedAt, syncId FROM "Save" WHERE gameId = ? ORDER BY slotNumber`)
    .all(gameId) as { name: string; kind: string; data: Uint8Array; updatedAt: number; syncId: string | null }[];
}

/* ------------------------------------------------------------------ garde */

test('sans session : 401, avant toute lecture', async () => {
  const { crc32 } = aPlayerWithAGame();
  assert.equal((await call('GET', `/${crc32}/sram`, null)).status, 401);
});

test('chaque réponse dit no-store : ce sont les sauvegardes d\'un compte', async () => {
  const { user, crc32 } = aPlayerWithAGame();
  const res = await call('GET', `/${crc32}/sram`, user.id);
  assert.equal(res.status, 200);
  assert.equal(res.cache, 'no-store');
});

test('un jeu hors de la bibliothèque : 404, avec une raison que le client range', async () => {
  const { user } = aPlayerWithAGame();
  const res = await call('GET', '/ABCDEF01/sram', user.id);
  assert.equal(res.status, 404);
  assert.equal(res.body.reason, 'not-in-library');
});

test('le checksum désigne la ligne DU JOUEUR : celle d\'un autre ne se lit pas', async () => {
  const theirs = aPlayerWithAGame();
  saveSram(db, theirs.game.id, theirs.user.id, Buffer.from([4, 2]));
  const me = insertUser(db);
  const res = await call('GET', `/${theirs.crc32}/sram`, me.id);
  assert.equal(res.status, 404);
});

test('une écriture au nom d\'un autre compte est refusée, même avec une session valide', async () => {
  const { user, crc32 } = aPlayerWithAGame();
  const res = await call('PUT', `/${crc32}/sram`, user.id, {
    syncId: syncId(), userId: 'someone-else', sram: b64(1), base: null, savedAt: Date.now()
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'account-mismatch');
});

test('un corps mal formé : 400, rien d\'écrit', async () => {
  const { user, crc32, game } = aPlayerWithAGame();
  const res = await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: 'pas du base64!', base: null, savedAt: Date.now() });
  assert.equal(res.status, 400);
  assert.equal((await call('GET', `/${crc32}/sram`, user.id)).body.sram, null);
  assert.equal(savesOf(game.id).length, 0);
});

/* ------------------------------------------------------------------- SRAM */

test('lire, écrire, relire : la version rendue est celle que la prochaine écriture citera', async () => {
  const { user, crc32 } = aPlayerWithAGame();
  assert.deepEqual((await call('GET', `/${crc32}/sram`, user.id)).body, { sram: null, updatedAt: null });

  const savedAt = Date.now() - 5000;
  const put = await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: b64(1, 2, 3), base: null, savedAt });
  assert.equal(put.status, 200);
  assert.equal(put.body.outcome, 'write');
  assert.equal(put.body.updatedAt, savedAt, 'datée du moment joué, pas de l\'arrivée');

  const read = await call('GET', `/${crc32}/sram`, user.id);
  assert.deepEqual(read.body, { sram: b64(1, 2, 3), updatedAt: savedAt });

  const next = await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: b64(4), base: savedAt, savedAt: Date.now() });
  assert.equal(next.body.outcome, 'fast-forward');
});

test('deux appareils divergents : la plus récente devient la SRAM, l\'autre est une sauvegarde datée', async () => {
  const { user, crc32, game } = aPlayerWithAGame();
  const t0 = Date.now() - 600_000;
  await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: b64(0), base: null, savedAt: t0 });

  // Les deux partent de t0. A revient d'abord avec une partie jouée à t0+300s,
  // B ensuite avec une partie jouée à t0+100s : B arrive le dernier, mais
  // joué plus tôt.
  const a = await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: b64(0xa), base: t0, savedAt: t0 + 300_000 });
  assert.equal(a.body.outcome, 'fast-forward');
  const b = await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: b64(0xb), base: t0, savedAt: t0 + 100_000 });
  assert.equal(b.body.outcome, 'stored-wins');
  assert.equal(b.body.sram, b64(0xa), 'B apprend ce qui est la SRAM désormais');

  assert.equal((await call('GET', `/${crc32}/sram`, user.id)).body.sram, b64(0xa));
  const kept = savesOf(game.id);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].kind, 'sram');
  assert.deepEqual([...kept[0].data], [0xb], 'la partie de B est gardée, octet pour octet');
  assert.equal(kept[0].updatedAt, t0 + 100_000, 'datée de quand B l\'a jouée');
});

test('la plus récente arrivant la seconde prend la place, et la précédente est gardée', async () => {
  const { user, crc32, game } = aPlayerWithAGame();
  const t0 = Date.now() - 600_000;
  await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: b64(0), base: null, savedAt: t0 });
  await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: b64(0xa), base: t0, savedAt: t0 + 100_000 });
  const b = await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: b64(0xb), base: t0, savedAt: t0 + 300_000 });
  assert.equal(b.body.outcome, 'incoming-wins');
  assert.equal(b.body.sram, null, 'rien à apprendre : c\'est la sienne');
  assert.equal((await call('GET', `/${crc32}/sram`, user.id)).body.sram, b64(0xb));
  assert.deepEqual(savesOf(game.id).map(s => [s.kind, [...s.data]]), [['sram', [0xa]]]);
});

test('un envoi rejoué après un conflit ne fabrique pas une seconde copie', async () => {
  const { user, crc32, game } = aPlayerWithAGame();
  const t0 = Date.now() - 600_000;
  await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: b64(1), base: null, savedAt: t0 + 200_000 });
  const upload = { syncId: syncId(), userId: user.id, sram: b64(2), base: null, savedAt: t0 };
  const first = await call('PUT', `/${crc32}/sram`, user.id, upload);
  const again = await call('PUT', `/${crc32}/sram`, user.id, upload);
  assert.equal(first.body.outcome, 'stored-wins');
  assert.equal(again.body.outcome, 'duplicate');
  assert.equal(savesOf(game.id).length, 1);
});

test('restaurer une SRAM gardée est un échange : la courante est gardée à son tour', async () => {
  const { user, crc32, game } = aPlayerWithAGame();
  const t0 = Date.now() - 600_000;
  await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: b64(1), base: null, savedAt: t0 + 200_000 });
  await call('PUT', `/${crc32}/sram`, user.id, { syncId: syncId(), userId: user.id, sram: b64(2), base: null, savedAt: t0 });
  const keptId = (db.query(`SELECT id FROM "Save" WHERE gameId = ?`).get(game.id) as { id: string }).id;

  const res = await call('POST', `/${crc32}/sram/restore`, user.id, { saveId: keptId });
  assert.equal(res.status, 200);
  assert.equal(res.body.sram, b64(2));
  assert.equal((await call('GET', `/${crc32}/sram`, user.id)).body.sram, b64(2));
  assert.deepEqual(savesOf(game.id).map(s => [s.kind, [...s.data]]), [['sram', [1]]], 'l\'ancienne courante est gardée');
});

test('restaurer la sauvegarde d\'un autre : 404', async () => {
  const theirs = aPlayerWithAGame();
  await call('PUT', `/${theirs.crc32}/sram`, theirs.user.id, { syncId: syncId(), userId: theirs.user.id, sram: b64(1), base: null, savedAt: Date.now() - 1000 });
  await call('PUT', `/${theirs.crc32}/sram`, theirs.user.id, { syncId: syncId(), userId: theirs.user.id, sram: b64(2), base: null, savedAt: Date.now() - 90_000 });
  const keptId = (db.query(`SELECT id FROM "Save" WHERE gameId = ?`).get(theirs.game.id) as { id: string }).id;
  const mine = aPlayerWithAGame();
  const res = await call('POST', `/${mine.crc32}/sram/restore`, mine.user.id, { saveId: keptId });
  assert.equal(res.status, 404);
});

/* ------------------------------------------------------------- savestates */

test('un savestate envoyé est créé, et un second envoi du même ne double rien', async () => {
  const { user, crc32, game } = aPlayerWithAGame();
  const upload = { syncId: syncId(), userId: user.id, name: 'Soir', data: b64(9, 9), screenshot: null, savedAt: Date.now() - 1000 };
  const first = await call('POST', `/${crc32}/states`, user.id, upload);
  const again = await call('POST', `/${crc32}/states`, user.id, upload);
  assert.equal(first.body.outcome, 'create');
  assert.equal(again.body.outcome, 'duplicate');
  assert.equal(again.body.saveId, first.body.saveId);
  assert.equal(savesOf(game.id).length, 1);
});

test('deux sauvegardes rapides prises hors-ligne sur deux appareils : les deux restent', async () => {
  const { user, crc32, game } = aPlayerWithAGame();
  const t = Date.now() - 600_000;
  await call('POST', `/${crc32}/states`, user.id, { syncId: syncId(), userId: user.id, name: '__quick__', data: b64(0xa), savedAt: t + 300_000 });
  const b = await call('POST', `/${crc32}/states`, user.id, { syncId: syncId(), userId: user.id, name: '__quick__', data: b64(0xb), savedAt: t + 100_000 });
  assert.equal(b.body.outcome, 'keep-beside-quick');
  assert.deepEqual(
    savesOf(game.id).map(s => [s.name, [...s.data]]),
    [['__quick__', [0xa]], ['__kept__', [0xb]]]
  );
});

test('une vignette qui n\'est pas une image matricielle est refusée', async () => {
  const { user, crc32 } = aPlayerWithAGame();
  const res = await call('POST', `/${crc32}/states`, user.id, {
    syncId: syncId(), userId: user.id, name: 'x', data: b64(1), savedAt: Date.now(),
    screenshot: 'data:image/svg+xml;base64,PHN2Zz4='
  });
  assert.equal(res.status, 400);
});

/* ------------------------------------------------- la copie hors-ligne */

test('une seule sauvegarde et ses octets, pour la copie de l\'appareil', async () => {
  const { user, crc32 } = aPlayerWithAGame();
  const id = syncId();
  const sent = await call('POST', `/${crc32}/states`, user.id, { syncId: id, userId: user.id, name: 'Soir', data: b64(7, 8), screenshot: null, savedAt: Date.now() - 1000 });
  const read = await call('GET', `/${crc32}/states/${sent.body.saveId}`, user.id);
  assert.equal(read.status, 200);
  assert.equal(read.cache, 'no-store');
  assert.equal(read.body.name, 'Soir');
  assert.equal(read.body.kind, 'state');
  assert.equal(read.body.syncId, id);
  assert.deepEqual([...Buffer.from(read.body.data, 'base64')], [7, 8]);
});

test('la sauvegarde d\'un autre, ou d\'un autre jeu, ne se lit pas : 404', async () => {
  const a = aPlayerWithAGame();
  const b = aPlayerWithAGame();
  const sent = await call('POST', `/${a.crc32}/states`, a.user.id, { syncId: syncId(), userId: a.user.id, name: 'x', data: b64(1), savedAt: Date.now() - 1000 });
  assert.equal((await call('GET', `/${a.crc32}/states/${sent.body.saveId}`, b.user.id)).status, 404);
  assert.equal((await call('GET', `/${b.crc32}/states/${sent.body.saveId}`, b.user.id)).status, 404);
});
