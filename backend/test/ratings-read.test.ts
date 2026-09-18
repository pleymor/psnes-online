/**
 * Ce que les écrans lisent, et ce qu'ils ne doivent pas voir.
 *
 * Trois requêtes en lecture seule. Ce qui vaut d'être épinglé n'est pas
 * qu'elles rendent des lignes, c'est l'ORDRE du classement, le fait qu'un
 * joueur sans partie n'y figure pas, et qu'un invité - dont la colonne est
 * NULL depuis #61 - ne casse pas l'historique en le traversant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { recordMatch } from '../src/db/matches.js';
import { rankingFor, standingsOf, recentMatches } from '../src/db/matches.js';

const GAME = '8F24F886';

/** Une partie prête à insérer ; seuls les champs qui comptent sont nommés. */
function play(
  db: ReturnType<typeof migratedDb>,
  p1: string | null, p2: string | null, winner: 0 | 1 | 2, at: number, frame: number
) {
  recordMatch(db, {
    playedAt: at, gameCrc32: GAME, roomId: 'r1', sessionId: 's1', frame,
    p1UserId: p1, p2UserId: p2, winner, p1Health: 80, p2Health: 0
  });
}

test('le classement est trié par cote décroissante', () => {
  const db = migratedDb();
  const a = insertUser(db, { pseudo: 'Alice' });
  const b = insertUser(db, { pseudo: 'Bob' });
  play(db, a.id, b.id, 1, 1000, 30);
  play(db, a.id, b.id, 1, 2000, 60);

  const rows = rankingFor(db, GAME, 50, 0);
  assert.deepEqual(rows.map(r => r.pseudo), ['Alice', 'Bob']);
  assert.ok(rows[0].rating > rows[1].rating, 'le premier doit avoir la plus grosse cote');
  assert.equal(rows[0].matches, 2);
});

test('a cote egale, le departage est par nombre de parties puis pseudo', () => {
  // Un nul ne deplace aucune cote : score attendu 0,5, score obtenu 0,5,
  // delta arrondi 0. Seul `matches` avance. Construction volontaire d'une
  // egalite reelle a quatre, pour que `ORDER BY r.rating DESC` seul ne
  // suffise plus a les departager - c'est le troisieme critere qui est vise.
  const db = migratedDb();
  const anna = insertUser(db, { pseudo: 'Anna' });
  const zoe = insertUser(db, { pseudo: 'Zoe' });
  const bob = insertUser(db, { pseudo: 'Bob' });
  const yann = insertUser(db, { pseudo: 'Yann' });

  play(db, anna.id, zoe.id, 0, 1000, 10);
  play(db, anna.id, zoe.id, 0, 2000, 20);
  play(db, bob.id, yann.id, 0, 3000, 30);

  const rows = rankingFor(db, GAME, 50, 0);
  assert.deepEqual(rows.map(r => r.pseudo), ['Bob', 'Yann', 'Anna', 'Zoe']);
  assert.ok(rows.every(r => r.rating === 1000), 'un nul ne deplace aucune cote');
});

test('un joueur qui n a jamais joué n est pas au classement', () => {
  const db = migratedDb();
  const a = insertUser(db);
  const b = insertUser(db);
  insertUser(db, { pseudo: 'Fantome' });
  play(db, a.id, b.id, 1, 1000, 30);

  const rows = rankingFor(db, GAME, 50, 0);
  assert.equal(rows.length, 2, 'la table ne contient que ceux qui ont joué');
  assert.ok(!rows.some(r => r.pseudo === 'Fantome'));
});

test('une partie contre un invité ne classe personne', () => {
  const db = migratedDb();
  const a = insertUser(db);
  play(db, a.id, null, 1, 1000, 30);

  assert.deepEqual(rankingFor(db, GAME, 50, 0), []);
});

test('un autre jeu a son propre classement', () => {
  const db = migratedDb();
  const a = insertUser(db, { pseudo: 'Alice' });
  const b = insertUser(db, { pseudo: 'Bob' });
  play(db, a.id, b.id, 1, 1000, 30);
  recordMatch(db, {
    playedAt: 1000, gameCrc32: 'AAAAAAAA', roomId: 'r1', sessionId: 's2', frame: 30,
    p1UserId: a.id, p2UserId: b.id, winner: 2, p1Health: 0, p2Health: 60
  });

  const ici = rankingFor(db, GAME, 50, 0);
  const ailleurs = rankingFor(db, 'AAAAAAAA', 50, 0);
  assert.equal(ici[0].pseudo, 'Alice');
  assert.equal(ailleurs[0].pseudo, 'Bob', 'les deux classements sont indépendants');
});

test('standingsOf rend une ligne par joueur demandé, classé ou non', () => {
  // Une ligne MEME sans cote : c'est ce qui permet a l'ecran de distinguer
  // « pas encore classe » de « jamais classable », que l'absence confondrait.
  const db = migratedDb();
  const a = insertUser(db);
  const b = insertUser(db);
  const c = insertUser(db);
  play(db, a.id, b.id, 1, 1000, 30);

  const rows = standingsOf(db, GAME, [a.id, c.id]);
  assert.equal(rows.length, 2);
  const alice = rows.find(r => r.userId === a.id)!;
  const carol = rows.find(r => r.userId === c.id)!;
  assert.ok(alice.rating !== null && alice.matches === 1);
  assert.equal(carol.rating, null, 'jamais joue : pas de cote, mais une ligne');
  assert.equal(carol.matches, null);
});

test('standingsOf dit si un joueur est un invite', () => {
  const db = migratedDb();
  const compte = insertUser(db);
  const invite = insertUser(db, { isAnonymous: 1 });

  const rows = standingsOf(db, GAME, [compte.id, invite.id]);
  assert.equal(rows.find(r => r.userId === compte.id)!.isAnonymous, false);
  assert.equal(rows.find(r => r.userId === invite.id)!.isAnonymous, true);
});

test('standingsOf ignore un identifiant qui ne correspond a personne', () => {
  const db = migratedDb();
  const a = insertUser(db);
  assert.deepEqual(standingsOf(db, GAME, [a.id, 'inconnu']).map(r => r.userId), [a.id]);
});

test('standingsOf sur une liste vide ne rend rien et ne jette pas', () => {
  const db = migratedDb();
  assert.deepEqual(standingsOf(db, GAME, []), []);
});

test('l historique est du plus récent au plus ancien, invités compris', () => {
  const db = migratedDb();
  const a = insertUser(db, { pseudo: 'Alice' });
  const b = insertUser(db, { pseudo: 'Bob' });
  play(db, a.id, b.id, 1, 1000, 30);
  play(db, a.id, null, 1, 2000, 60);

  const rows = recentMatches(db, GAME, 50, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].playedAt, 2000, 'le plus récent d abord');
  assert.equal(rows[0].p2, null, 'un invité laisse la place vide sans casser la ligne');
  assert.equal(rows[1].p1!.pseudo, 'Alice');
  assert.equal(rows[1].p2!.pseudo, 'Bob');
});
