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
import { recordMatch, ratingFor } from '../src/db/matches.js';
import { INITIAL_RATING, K_FACTOR } from '../src/ratings/elo.js';

/** Une partie prête à insérer, dont on ne change que ce qui compte au test. */
function match(over: Partial<Parameters<typeof recordMatch>[1]> = {}) {
  return {
    playedAt: 1000,
    gameCrc32: '8F24F886',
    roomId: 'r1',
    sessionId: 's1',
    frame: 30,
    p1UserId: null,
    p2UserId: null,
    winner: 1 as 0 | 1 | 2,
    p1Health: 80,
    p2Health: 0,
    ...over
  };
}

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

test('une partie classée écrit les deux cotes', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);

  const outcome = recordMatch(db, match({ p1UserId: alice.id, p2UserId: bob.id }));

  assert.deepEqual(outcome, { kind: 'recorded' });
  assert.equal(ratingFor(db, alice.id, '8F24F886'), INITIAL_RATING + K_FACTOR / 2);
  assert.equal(ratingFor(db, bob.id, '8F24F886'), INITIAL_RATING - K_FACTOR / 2);
});

test('le second rapport du même KO est un doublon, pas une seconde partie', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);
  const same = match({ p1UserId: alice.id, p2UserId: bob.id });

  recordMatch(db, same);
  const second = recordMatch(db, { ...same, playedAt: 1100 });

  assert.deepEqual(second, { kind: 'duplicate' });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM "Match"`).get() as { n: number };
  assert.equal(n.n, 1);
  // La cote n'a pas bougé deux fois.
  assert.equal(ratingFor(db, alice.id, '8F24F886'), INITIAL_RATING + K_FACTOR / 2);
});

test('deux pairs qui ne sont pas d’accord sont signalés, pas écrasés', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);
  const base = match({ p1UserId: alice.id, p2UserId: bob.id, winner: 1 });

  recordMatch(db, base);
  const second = recordMatch(db, { ...base, winner: 2 });

  assert.deepEqual(second, { kind: 'disagreement', stored: 1 });
  const stored = db.prepare(`SELECT winner FROM "Match"`).get() as { winner: number };
  assert.equal(stored.winner, 1, 'le premier rapport fait foi');
});

test('une partie contre un invité est gardée, mais ne classe personne', () => {
  const db = migratedDb();
  const alice = insertUser(db);

  recordMatch(db, match({ p1UserId: alice.id, p2UserId: null }));

  const n = db.prepare(`SELECT COUNT(*) AS n FROM "Match"`).get() as { n: number };
  assert.equal(n.n, 1, 'l’historique garde la partie');
  assert.equal(ratingFor(db, alice.id, '8F24F886'), INITIAL_RATING, 'et la cote ne bouge pas');
  const ratings = db.prepare(`SELECT COUNT(*) AS n FROM "Rating"`).get() as { n: number };
  assert.equal(ratings.n, 0);
});

test('une partie arrivée en retard se range à sa place', () => {
  // Deux bases identiques sauf l'ordre d'insertion : les cotes finales doivent
  // être les mêmes, puisque le recalcul relit l'historique trié.
  const ratingsAfter = (order: number[]) => {
    const db = migratedDb();
    const alice = insertUser(db, { id: `a-${order.join('')}` });
    const bob = insertUser(db, { id: `b-${order.join('')}` });
    const carol = insertUser(db, { id: `c-${order.join('')}` });
    const rows = [
      match({ playedAt: 1000, frame: 30, p1UserId: alice.id, p2UserId: bob.id, winner: 1 }),
      match({ playedAt: 2000, frame: 60, p1UserId: alice.id, p2UserId: carol.id, winner: 1 }),
      match({ playedAt: 3000, frame: 90, p1UserId: bob.id, p2UserId: carol.id, winner: 2 })
    ];
    for (const i of order) recordMatch(db, rows[i]);
    return [
      ratingFor(db, alice.id, '8F24F886'),
      ratingFor(db, bob.id, '8F24F886'),
      ratingFor(db, carol.id, '8F24F886')
    ];
  };

  assert.deepEqual(ratingsAfter([2, 0, 1]), ratingsAfter([0, 1, 2]));
});

test('deux jeux ont deux classements', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  const bob = insertUser(db);

  recordMatch(db, match({ p1UserId: alice.id, p2UserId: bob.id, winner: 1 }));
  recordMatch(db, match({
    gameCrc32: 'AAAAAAAA', sessionId: 's2', p1UserId: alice.id, p2UserId: bob.id, winner: 2
  }));

  assert.equal(ratingFor(db, alice.id, '8F24F886'), INITIAL_RATING + K_FACTOR / 2);
  assert.equal(ratingFor(db, alice.id, 'AAAAAAAA'), INITIAL_RATING - K_FACTOR / 2);
});

test('un joueur sans partie vaut le classement initial', () => {
  const db = migratedDb();
  const alice = insertUser(db);
  assert.equal(ratingFor(db, alice.id, '8F24F886'), INITIAL_RATING);
});
