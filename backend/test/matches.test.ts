/**
 * Les parties enregistrées, et les cotes qui en dérivent.
 *
 * La table est la source de vérité et `Rating` en est recalculé : c'est ce qui
 * permet de changer la formule, le facteur K ou le classement initial sans
 * perdre l'historique. Les tests ci-dessous pincent cette propriété autant que
 * les chiffres.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';

test('0008 crée les deux tables, et la clé unique porte sur la session', () => {
  const db = migratedDb();

  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('Match', 'Rating')`
  ).all() as { name: string }[];
  assert.deepEqual(tables.map(t => t.name).sort(), ['Match', 'Rating']);

  const indexes = db.prepare(`PRAGMA index_list('Match')`).all() as {
    name: string;
    unique: number;
  }[];
  const unique = indexes.find(i => i.name === 'Match_sessionId_frame_key');
  assert.ok(unique, 'Match_sessionId_frame_key doit exister');
  assert.equal(unique!.unique, 1);
});

test('une partie survit à la suppression de son joueur, une cote non', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);

  db.prepare(`
    INSERT INTO "Match" (id, playedAt, gameCrc32, roomId, sessionId, frame,
                         p1UserId, p2UserId, winner, p1Health, p2Health)
    VALUES ('m1', 1000, '8F24F886', 'r1', 's1', 30, ?, ?, 1, 80, 0)
  `).run(alice.id, bob.id);
  db.prepare(`
    INSERT INTO "Rating" (userId, gameCrc32, rating, matches) VALUES (?, '8F24F886', 1016, 1)
  `).run(alice.id);

  db.prepare(`DELETE FROM "User" WHERE id = ?`).run(alice.id);

  const match = db.prepare(`SELECT p1UserId, p2UserId FROM "Match" WHERE id = 'm1'`)
    .get() as { p1UserId: string | null; p2UserId: string | null };
  assert.equal(match.p1UserId, null, 'la partie reste, le joueur s’efface');
  assert.equal(match.p2UserId, bob.id);

  const ratings = db.prepare(`SELECT COUNT(*) AS n FROM "Rating"`).get() as { n: number };
  assert.equal(ratings.n, 0, 'une cote n’a pas de sens sans son compte');
});

test('deux parties de la même session ne peuvent pas partager une image', () => {
  const db = migratedDb();
  const insert = (id: string, frame: number) =>
    db.prepare(`
      INSERT INTO "Match" (id, playedAt, gameCrc32, roomId, sessionId, frame,
                           p1UserId, p2UserId, winner, p1Health, p2Health)
      VALUES (?, 1000, '8F24F886', 'r1', 's1', ?, NULL, NULL, 1, 80, 0)
    `).run(id, frame);

  insert('m1', 30);
  assert.throws(() => insert('m2', 30));
  insert('m3', 60);
});

test('deux sessions du même salon peuvent partager une image', () => {
  // Le compteur d’images repart de zéro à la session suivante ; sans le
  // sessionId dans la clé, la seconde partie serait rejetée comme un doublon.
  const db = migratedDb();
  const insert = (id: string, sessionId: string) =>
    db.prepare(`
      INSERT INTO "Match" (id, playedAt, gameCrc32, roomId, sessionId, frame,
                           p1UserId, p2UserId, winner, p1Health, p2Health)
      VALUES (?, 1000, '8F24F886', 'r1', ?, 1800, NULL, NULL, 1, 80, 0)
    `).run(id, sessionId);

  insert('m1', 's1');
  insert('m2', 's2');
  const n = db.prepare(`SELECT COUNT(*) AS n FROM "Match"`).get() as { n: number };
  assert.equal(n.n, 2);
});
