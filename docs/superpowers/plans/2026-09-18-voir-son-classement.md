# Voir son classement — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre visibles, dans la webapp, le classement Elo d'un jeu, l'historique de ses parties, et les cotes des deux joueurs d'un salon avant le lancement.

**Architecture :** Une surface de lecture seule. Trois requêtes dans `db/matches.ts`, un routeur Express derrière `requireAuth` + `requirePseudo`, un module client en union discriminée, un module pur qui décide quoi montrer dans les quatre cas ambigus, les cotes dans le composant des sièges, et une route dynamique pour l'écran complet.

**Tech Stack :** TypeScript, Svelte 4, SvelteKit (adapter-static, `ssr = false`), Bun, bun:sqlite, Express, `node:test` + `node:assert/strict`.

**Spec :** `docs/superpowers/specs/2026-09-18-voir-son-classement-design.md`

## Global Constraints

- **Rien de ce chantier n'écrit en base.** C'est une surface de lecture, et elle doit le rester. Aucune modification de `Match`, de `Rating`, ni d'une migration.
- **Les routes portent `requireAuth` ET `requirePseudo`**, montées dans `backend/src/bootstrap/app.ts` sur le modèle de `app.use('/api/friends', requirePseudo, friendsRouter)` (l. 196). Aucune route non authentifiée.
- **Ce qu'une réponse expose d'un joueur : `id`, `pseudo`, `discriminator`, `avatar` — ce que produit `toPublicUser()` — plus `rating` et `matches`.** Rien d'autre.
- **`matches === 0` se dit « non classé », jamais « 1000 ».** Un nombre ressemble à un résultat.
- **Indentation : 2 espaces côté backend.** Le code de ce plan fait autorité sur la logique et les valeurs, pas sur la mise en forme.
- **Imports depuis `core/test` :** chemins relatifs avec extension `.js`, jamais l'alias `$lib` — ces tests tournent sous node nu.
- **Un `core/test/*.test.ts` neuf ne tourne pas tant qu'il n'est pas nommé dans `test:ui` du `package.json` racine.** `backend/test/*.test.ts` est un glob et s'auto-énumère.
- **Commandes :** `bun run test:ui`, `bun run test:backend`, `bun run test:all` depuis la racine ; `cd frontend && bun run build`. Jamais `npx tsx`.

---

## Structure des fichiers

| fichier | responsabilité |
|---|---|
| `backend/src/db/matches.ts` | **modifié.** Trois lectures : classement, cotes d'une liste de joueurs, historique |
| `backend/src/api/ratings.ts` | **créé.** Le routeur |
| `backend/src/bootstrap/app.ts` | **modifié.** Monter le routeur |
| `backend/test/ratings-read.test.ts` | **créé.** Les lectures, sur une vraie base |
| `frontend/src/lib/ratings/presentation.ts` | **créé.** Les quatre cas, purs |
| `frontend/src/lib/api/ratings.ts` | **créé.** Les appels, en union discriminée |
| `core/test/ratings-presentation.test.ts` | **créé.** Les règles |
| `frontend/src/lib/components/RoomPlayers.svelte` | **modifié.** Les deux cotes, et le lien dessous |
| `frontend/src/routes/classement/[crc32]/+page.ts` et `+page.svelte` | **créés.** L'écran |
| `frontend/src/lib/nav/way-back.ts` | **modifié.** Une règle de préfixe |
| `core/test/way-back.test.ts` | **modifié.** Le nouveau cas |
| `frontend/src/lib/i18n/translations.ts` | **modifié.** Les deux langues |
| `frontend/src/lib/docs/content.ts` | **modifié.** Ce que le service montre |
| `package.json` | **modifié.** Le fichier de test neuf dans `test:ui` |

---

### Task 1 : Les trois lectures en base

**Files:**
- Modify: `backend/src/db/matches.ts`
- Test: `backend/test/ratings-read.test.ts` (créé — glob, rien à ajouter au `package.json`)

**Interfaces:**
- Consumes: les tables `Match` et `Rating` (migration 0008) ; `INITIAL_RATING` de `../ratings/elo.js`.
- Produces:
  ```ts
  export interface RankedPlayer {
    userId: string; pseudo: string; discriminator: string; avatar: string | null;
    rating: number; matches: number;
  }
  export interface PlayedRow {
    id: string; playedAt: number; winner: 0 | 1 | 2;
    p1: { userId: string; pseudo: string; discriminator: string } | null;
    p2: { userId: string; pseudo: string; discriminator: string } | null;
    p1Health: number; p2Health: number;
  }
  export interface PlayerStanding {
    userId: string; pseudo: string; discriminator: string; avatar: string | null;
    isAnonymous: boolean;
    /** null quand ce joueur n'a jamais joué de partie classée sur ce jeu. */
    rating: number | null;
    matches: number | null;
  }
  export function rankingFor(db: Database, gameCrc32: string, limit: number, offset: number): RankedPlayer[];
  export function standingsOf(db: Database, gameCrc32: string, userIds: string[]): PlayerStanding[];
  export function recentMatches(db: Database, gameCrc32: string, limit: number, offset: number): PlayedRow[];
  ```

- [ ] **Step 1 : Écrire les tests qui échouent**

Créer `backend/test/ratings-read.test.ts` :

```ts
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

test('standingsOf rend une ligne par joueur demandé, class\u00e9 ou non', () => {
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
```

- [ ] **Step 2 : Lancer et vérifier l'échec**

Run: `bun test backend/test/ratings-read.test.ts`
Expected: FAIL — `rankingFor` n'est pas exportée.

- [ ] **Step 3 : Écrire les trois lectures**

À ajouter à la fin de `backend/src/db/matches.ts` :

```ts
/* ------------------------------------------------------------- les lectures */

/**
 * Ce qu'un écran a le droit de savoir d'un joueur classé.
 *
 * La forme publique d'un utilisateur - ce que rend `toPublicUser()` - plus la
 * cote et le nombre de parties. Ni date de création, ni identifiant Google :
 * une requête qui rendrait `SELECT *` exposerait les deux sans que personne le
 * remarque, d'où les colonnes nommées une par une ci-dessous.
 */
export interface RankedPlayer {
  userId: string;
  pseudo: string;
  discriminator: string;
  avatar: string | null;
  rating: number;
  matches: number;
}

/** Un joueur du salon, classé ou non, invité ou non. */
export interface PlayerStanding {
  userId: string;
  pseudo: string;
  discriminator: string;
  avatar: string | null;
  isAnonymous: boolean;
  /** null quand ce joueur n'a jamais joué de partie classée sur ce jeu. */
  rating: number | null;
  matches: number | null;
}

/**
 * Le classement d'un jeu, du plus fort au plus faible.
 *
 * Servi par `Rating_gameCrc32_rating_idx`. Un joueur sans ligne `Rating` n'y
 * figure pas, et c'est voulu : la table ne contient que ceux qui ont joué, et
 * l'absence vaut `INITIAL_RATING` partout où la question se pose.
 *
 * Le départage à cote égale est `matches` croissant puis `pseudo` : sans lui
 * l'ordre de deux joueurs à 1000 dépendrait du plan d'exécution, et la page
 * changerait d'ordre entre deux chargements sans que rien n'ait bougé.
 */
export function rankingFor(
  db: Database, gameCrc32: string, limit: number, offset: number
): RankedPlayer[] {
  return db.prepare(`
    SELECT r.userId, u.pseudo, u.discriminator, u.avatar, r.rating, r.matches
    FROM "Rating" r
    JOIN "User" u ON u.id = r.userId
    WHERE r.gameCrc32 = ?
    ORDER BY r.rating DESC, r.matches ASC, u.pseudo ASC
    LIMIT ? OFFSET ?
  `).all(gameCrc32, limit, offset) as RankedPlayer[];
}

/**
 * Ce que le salon a besoin de savoir de ses deux joueurs.
 *
 * Une ligne par joueur demandé, **même sans cote** - et c'est tout l'intérêt.
 * Un siège sans cote peut vouloir dire deux choses opposées : un compte qui n'a
 * pas encore joué, et qui sera classé au premier combat, ou un invité qui ne le
 * sera jamais, sa colonne étant NULL dès l'insertion depuis #61. Rendre
 * l'absence confondrait les deux, et l'écran dirait « non classé » à quelqu'un
 * à qui il faut dire « invité ».
 *
 * Le fait vient de `User`, sa source, plutôt que d'un champ recopié dans
 * `RoomPlayer` : un salon relu depuis un instantané porterait une valeur
 * périmée, et élargir ce type ferait payer le lobby VR et la présence pour un
 * affichage.
 *
 * `LEFT JOIN` sur `Rating`, donc, et la sélection part de `User`.
 */
export function standingsOf(
  db: Database, gameCrc32: string, userIds: string[]
): PlayerStanding[] {
  // Une liste vide produirait `IN ()`, que SQLite refuse. Court-circuiter est
  // plus honnête que de fabriquer un marqueur qui ne correspond à personne.
  if (userIds.length === 0) return [];
  const marks = userIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT u.id AS userId, u.pseudo, u.discriminator, u.avatar, u.isAnonymous,
           r.rating, r.matches
    FROM "User" u
    LEFT JOIN "Rating" r ON r.userId = u.id AND r.gameCrc32 = ?
    WHERE u.id IN (${marks})
  `).all(gameCrc32, ...userIds) as Record<string, unknown>[];

  return rows.map(r => ({
    userId: r.userId as string,
    pseudo: r.pseudo as string,
    discriminator: r.discriminator as string,
    avatar: (r.avatar as string | null) ?? null,
    // SQLite n'a pas de booléen, et ce champ décide de ce que l'écran dit :
    // `=== 1` comme `db/users.ts`, jamais un test de véracité.
    isAnonymous: r.isAnonymous === 1,
    rating: (r.rating as number | null) ?? null,
    matches: (r.matches as number | null) ?? null
  }));
}

/** Un joueur tel qu'une ligne d'historique le nomme, ou null. */
interface PlayedSide {
  userId: string;
  pseudo: string;
  discriminator: string;
}

export interface PlayedRow {
  id: string;
  playedAt: number;
  winner: 0 | 1 | 2;
  p1: PlayedSide | null;
  p2: PlayedSide | null;
  p1Health: number;
  p2Health: number;
}

/**
 * L'historique d'un jeu, du plus récent au plus ancien.
 *
 * `LEFT JOIN` des deux côtés, et non `JOIN` : un invité n'a jamais eu
 * d'identifiant, et un compte supprimé a laissé la sienne à NULL. Un `JOIN`
 * ferait disparaître ces parties de l'historique - or elles ont bien eu lieu,
 * et c'est exactement ce que l'écran existe pour montrer.
 */
export function recentMatches(
  db: Database, gameCrc32: string, limit: number, offset: number
): PlayedRow[] {
  const rows = db.prepare(`
    SELECT m.id, m.playedAt, m.winner, m.p1Health, m.p2Health,
           m.p1UserId, u1.pseudo AS p1Pseudo, u1.discriminator AS p1Disc,
           m.p2UserId, u2.pseudo AS p2Pseudo, u2.discriminator AS p2Disc
    FROM "Match" m
    LEFT JOIN "User" u1 ON u1.id = m.p1UserId
    LEFT JOIN "User" u2 ON u2.id = m.p2UserId
    WHERE m.gameCrc32 = ?
    ORDER BY m.playedAt DESC, m.frame DESC
    LIMIT ? OFFSET ?
  `).all(gameCrc32, limit, offset) as Record<string, unknown>[];

  const side = (id: unknown, pseudo: unknown, disc: unknown): PlayedSide | null =>
    typeof id === 'string' && typeof pseudo === 'string' && typeof disc === 'string'
      ? { userId: id, pseudo, discriminator: disc }
      : null;

  return rows.map(r => ({
    id: r.id as string,
    playedAt: r.playedAt as number,
    winner: r.winner as 0 | 1 | 2,
    p1: side(r.p1UserId, r.p1Pseudo, r.p1Disc),
    p2: side(r.p2UserId, r.p2Pseudo, r.p2Disc),
    p1Health: r.p1Health as number,
    p2Health: r.p2Health as number
  }));
}
```

- [ ] **Step 4 : Lancer et vérifier le succès**

Run: `bun test backend/test/ratings-read.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5 : La suite backend**

Run: `bun run test:backend`
Expected: PASS. Le nombre de fichiers doit avoir augmenté de un.

- [ ] **Step 6 : Commit**

```bash
git add backend/src/db/matches.ts backend/test/ratings-read.test.ts
git commit -m "Lire le classement, les cotes de deux joueurs, et l'historique"
```

---

### Task 2 : Le routeur

**Files:**
- Create: `backend/src/api/ratings.ts`
- Modify: `backend/src/bootstrap/app.ts`
- Test: `backend/test/ratings-read.test.ts` (étendu)

**Interfaces:**
- Consumes: `rankingFor`, `standingsOf`, `recentMatches` (Task 1).
- Produces: `export const ratingsRouter` ; les trois routes décrites ci-dessous.

- [ ] **Step 1 : Écrire les tests qui échouent**

Le routeur lui-même se teste mal sans monter Express ; ce qui compte et se
prouve, c'est la **validation des paramètres**. L'extraire en fonction pure est
le patron du dépôt (`auth/anonymous.ts`, `saves/import-plan.ts`).

À ajouter à `backend/test/ratings-read.test.ts` :

```ts
import { pageOf, isCrc32 } from '../src/api/ratings.js';

test('un CRC32 est huit caractères hexadécimaux majuscules', () => {
  assert.equal(isCrc32('8F24F886'), true);
  assert.equal(isCrc32('8f24f886'), false, 'la casse compte : Game.crc32 est en majuscules');
  assert.equal(isCrc32('8F24F88'), false);
  assert.equal(isCrc32('../../etc/passwd'), false);
  assert.equal(isCrc32(''), false);
});

test('la pagination est bornée, et un paramètre absurde retombe sur le défaut', () => {
  assert.deepEqual(pageOf(undefined, undefined), { limit: 50, offset: 0 });
  assert.deepEqual(pageOf('10', '20'), { limit: 10, offset: 20 });
  assert.deepEqual(pageOf('100000', '0').limit, 200, 'le plafond protège la base');
  assert.deepEqual(pageOf('0', '0').limit, 50, 'zéro n est pas une page');
  assert.deepEqual(pageOf('-5', '-5'), { limit: 50, offset: 0 });
  assert.deepEqual(pageOf('abc', 'abc'), { limit: 50, offset: 0 });
});
```

- [ ] **Step 2 : Lancer et vérifier l'échec**

Run: `bun test backend/test/ratings-read.test.ts`
Expected: FAIL — `api/ratings.js` n'existe pas.

- [ ] **Step 3 : Écrire le routeur**

Créer `backend/src/api/ratings.ts` :

```ts
/**
 * Ce que les écrans de classement ont le droit de lire.
 *
 * Trois routes en lecture seule, derrière `requireAuth` et `requirePseudo` comme
 * `friendsRouter` : le classement est visible de tout joueur connecté, et de
 * personne d'autre. Pas de route ouverte - le dépôt vient d'en refermer une.
 *
 * `requirePseudo` en plus du compte, et pour la même raison que les amis : un
 * compte encore derrière le portique de pseudonyme n'a pas de nom à afficher, et
 * le laisser passer ferait apparaître une ligne sans identité.
 *
 * Les deux fonctions de validation sont exportées et pures, parce que c'est
 * elles que l'on peut prouver : un handler Express ne se pilote pas dans un
 * test, et une règle écrite dedans est une règle que personne ne vérifie.
 */

import { Router } from 'express';
import { getDb } from '../db/sqlite.js';
import { rankingFor, standingsOf, recentMatches } from '../db/matches.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';

/** Combien de lignes une page rend par défaut, et au plus. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Le checksum tel que `Game.crc32` le porte : huit hexadécimaux MAJUSCULES.
 *
 * La casse n'est pas un détail : `watcherFor()` compare en majuscules et
 * `POST /api/games` refuse déjà tout le reste. Accepter les minuscules ici
 * créerait deux orthographes du même jeu, dont une qui ne trouve jamais rien.
 */
export function isCrc32(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9A-F]{8}$/.test(value);
}

/**
 * La page demandée, ramenée dans des bornes.
 *
 * Tout ce qui n'est pas un entier utile retombe sur le défaut plutôt que de
 * produire une erreur : une page est une commodité, et refuser une requête
 * parce qu'un `?limit=` est bizarre coûterait un écran blanc pour rien. Le
 * plafond, lui, n'est pas négociable - c'est ce qui empêche une seule requête
 * de lire toute la table.
 */
export function pageOf(limit: unknown, offset: unknown): { limit: number; offset: number } {
  const n = (value: unknown, fallback: number, max: number) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
  };
  const off = Number(offset);
  return {
    limit: n(limit, DEFAULT_LIMIT, MAX_LIMIT),
    offset: Number.isInteger(off) && off > 0 ? off : 0
  };
}

export const ratingsRouter = Router();

ratingsRouter.use(requireAuth);

/**
 * Le classement d'un jeu, ou les cotes de joueurs nommés.
 *
 * `?users=a,b` sert le salon, qui n'a besoin que de deux lignes et n'a aucune
 * raison de tirer la table entière pour les trouver. Cette forme-là rend une
 * ligne par joueur demandé même sans cote, parce que l'écran doit distinguer
 * « pas encore classé » de « jamais classable ».
 */
ratingsRouter.get('/:crc32', asyncHandler(async (req, res) => {
  const { crc32 } = req.params;
  if (!isCrc32(crc32)) return res.status(400).json({ error: 'A CRC32 checksum is required' });

  const users = typeof req.query.users === 'string'
    ? req.query.users.split(',').map(s => s.trim()).filter(Boolean)
    : null;

  if (users) {
    // Borné comme le reste : `?users=` est une liste écrite par un client.
    return res.json(standingsOf(getDb(), crc32, users.slice(0, MAX_LIMIT)));
  }

  const { limit, offset } = pageOf(req.query.limit, req.query.offset);
  res.json(rankingFor(getDb(), crc32, limit, offset));
}));

/** L'historique d'un jeu, du plus récent au plus ancien. */
ratingsRouter.get('/:crc32/matches', asyncHandler(async (req, res) => {
  const { crc32 } = req.params;
  if (!isCrc32(crc32)) return res.status(400).json({ error: 'A CRC32 checksum is required' });

  const { limit, offset } = pageOf(req.query.limit, req.query.offset);
  res.json(recentMatches(getDb(), crc32, limit, offset));
}));
```

Dans `backend/src/bootstrap/app.ts`, à côté des autres montages (vers la l. 196) :

```ts
  app.use('/api/ratings', requirePseudo, ratingsRouter);
```

avec l'import correspondant, sur le modèle de celui de `friendsRouter` (l. 14).

- [ ] **Step 4 : Lancer et vérifier le succès**

Run: `bun test backend/test/ratings-read.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5 : La suite backend**

Run: `bun run test:backend`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
git add backend/src/api/ratings.ts backend/src/bootstrap/app.ts backend/test/ratings-read.test.ts
git commit -m "Servir le classement et l'historique aux joueurs connectés"
```

---

### Task 3 : Le module de présentation, pur

**Files:**
- Create: `frontend/src/lib/ratings/presentation.ts`
- Create: `core/test/ratings-presentation.test.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Produces:
  ```ts
  export type RatingDisplay =
    | { kind: 'hidden' }
    | { kind: 'guest' }
    | { kind: 'unranked' }
    | { kind: 'rated'; rating: number; matches: number };

  /** La ligne que `standingsOf` rend pour ce joueur, ou null pour un siège vide. */
  export interface Standing {
    userId: string; isAnonymous: boolean;
    rating: number | null; matches: number | null;
  }
  export function ratingDisplay(input: {
    gameCrc32: string | null | undefined;
    watched: boolean;
    standing: Standing | null | undefined;
  }): RatingDisplay;
  ```

- [ ] **Step 1 : Écrire les tests qui échouent**

Créer `core/test/ratings-presentation.test.ts` :

```ts
/**
 * Ce qu'un siège de salon affiche à la place d'une cote, quand il n'y en a pas.
 *
 * Quatre situations produisent « pas de cote », et elles ne veulent pas dire la
 * même chose. Les confondre donne un écran qui ment : « 1000 » pour quelqu'un
 * qui n'a jamais joué ressemble à un résultat, et deux cases vides sur un jeu
 * non observé promettent qu'elles vont se remplir un jour.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ratingDisplay } from '../../frontend/src/lib/ratings/presentation.js';

const CLASSEE = { userId: 'alice', isAnonymous: false, rating: 1016, matches: 3 };
const JAMAIS_JOUE = { userId: 'bob', isAnonymous: false, rating: null, matches: null };
const INVITE = { userId: 'guest', isAnonymous: true, rating: null, matches: null };

test('sans jeu choisi, on ne montre rien', () => {
  assert.deepEqual(
    ratingDisplay({ gameCrc32: null, watched: false, standing: CLASSEE }),
    { kind: 'hidden' }
  );
});

test('sur un jeu que personne ne sait lire, on ne montre rien non plus', () => {
  // Et surtout pas « non classé », qui laisserait croire qu'une partie
  // suffirait à remplir la case.
  assert.deepEqual(
    ratingDisplay({ gameCrc32: 'DEADBEEF', watched: false, standing: CLASSEE }),
    { kind: 'hidden' }
  );
});

test('un siège vide ne montre rien', () => {
  assert.deepEqual(
    ratingDisplay({ gameCrc32: '8F24F886', watched: true, standing: null }),
    { kind: 'hidden' }
  );
});

test('un invité est dit invité, pas non classé', () => {
  // Il n'a pas d'identité durable : sa colonne est NULL dès l'insertion, donc
  // il ne sera JAMAIS classé. « Non classé » suggérerait qu'un combat suffirait.
  assert.deepEqual(
    ratingDisplay({ gameCrc32: '8F24F886', watched: true, standing: INVITE }),
    { kind: 'guest' }
  );
});

test('un compte sans partie sur ce jeu est non classé', () => {
  assert.deepEqual(
    ratingDisplay({ gameCrc32: '8F24F886', watched: true, standing: JAMAIS_JOUE }),
    { kind: 'unranked' }
  );
});

test('un compte qui a joué montre sa cote et son nombre de parties', () => {
  assert.deepEqual(
    ratingDisplay({ gameCrc32: '8F24F886', watched: true, standing: CLASSEE }),
    { kind: 'rated', rating: 1016, matches: 3 }
  );
});

test('une ligne à zéro partie est traitée comme non classée', () => {
  // La base ne devrait pas en produire, mais l'écran ne doit pas afficher
  // « 1000 · 0 partie », qui est la formulation la plus trompeuse possible.
  assert.deepEqual(
    ratingDisplay({
      gameCrc32: '8F24F886', watched: true,
      standing: { userId: 'alice', isAnonymous: false, rating: 1000, matches: 0 }
    }),
    { kind: 'unranked' }
  );
});

test('un invité prime sur tout le reste', () => {
  // Si une ligne d'invité portait une cote - ce que #61 rend impossible, mais
  // qu'un defaut futur pourrait produire - c'est « invité » qu'il faut dire.
  assert.deepEqual(
    ratingDisplay({
      gameCrc32: '8F24F886', watched: true,
      standing: { userId: 'guest', isAnonymous: true, rating: 1200, matches: 9 }
    }),
    { kind: 'guest' }
  );
});
```

- [ ] **Step 2 : Nommer le fichier dans `test:ui`**

Sans ça il ne tournera jamais. Dans le `package.json` racine, ajouter
`core/test/ratings-presentation.test.ts` à la liste du script `test:ui`, à côté
de `core/test/match-recorder.test.ts`. La ligne est énorme : éditer
chirurgicalement, ne rien réordonner.

- [ ] **Step 3 : Lancer et vérifier l'échec**

Run: `bun test core/test/ratings-presentation.test.ts`
Expected: FAIL — le module n'existe pas.

- [ ] **Step 4 : Écrire le module**

Créer `frontend/src/lib/ratings/presentation.ts` :

```ts
/**
 * Ce qu'un écran affiche à la place d'une cote, quand il n'y en a pas.
 *
 * Quatre situations produisent « pas de cote » et ne veulent pas dire la même
 * chose : pas de jeu choisi, un jeu dont personne ne sait lire la mémoire, un
 * joueur sans compte, et un compte qui n'a pas encore joué. Les confondre donne
 * un écran qui ment - « 1000 » pour quelqu'un qui n'a jamais joué ressemble à un
 * résultat, et une case vide sur un jeu non observé promet qu'elle se remplira.
 *
 * Pur et sans store, pour la même raison que `rooms/anonymous-join.ts` : c'est
 * la règle qui décide de ce que le joueur voit, elle doit se lire seule et se
 * prouver sans navigateur.
 */

export type RatingDisplay =
  /** Rien à montrer, et rien à promettre. */
  | { kind: 'hidden' }
  /** Un joueur sans compte : jamais classé, et ce n'est pas un défaut. */
  | { kind: 'guest' }
  /** Un compte qui n'a pas encore joué sur ce jeu. */
  | { kind: 'unranked' }
  | { kind: 'rated'; rating: number; matches: number };

/** La ligne que `standingsOf` rend pour un joueur, ou null pour un siège vide. */
export interface Standing {
  userId: string;
  isAnonymous: boolean;
  rating: number | null;
  matches: number | null;
}

export function ratingDisplay(input: {
  /** Le jeu du salon, ou null tant qu'aucun n'est choisi. */
  gameCrc32: string | null | undefined;
  /** Si ce jeu a une ligne dans `watched-roms.ts`. Faux : aucune partie n'en sortira. */
  watched: boolean;
  standing: Standing | null | undefined;
}): RatingDisplay {
  if (!input.gameCrc32 || !input.watched) return { kind: 'hidden' };
  if (!input.standing) return { kind: 'hidden' };

  // Avant tout le reste : un invité n'a pas d'identité durable, donc il ne sera
  // jamais classé. Le dire « non classé » laisserait croire qu'un combat
  // suffirait à remplir la case.
  if (input.standing.isAnonymous) return { kind: 'guest' };

  const { rating, matches } = input.standing;
  // Zéro partie vaut absence : la base ne devrait pas produire une telle ligne,
  // mais « 1000 · 0 partie » serait la formulation la plus trompeuse possible.
  if (rating === null || matches === null || matches === 0) return { kind: 'unranked' };

  return { kind: 'rated', rating, matches };
}
```

- [ ] **Step 5 : Lancer et vérifier le succès**

Run: `bun test core/test/ratings-presentation.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6 : Vérifier que le fichier tourne dans la suite**

Run: `bun run test:ui`
Expected: PASS, et le **nombre de fichiers** a augmenté de un. Vérifier ce
nombre, pas seulement la couleur.

- [ ] **Step 7 : Commit**

```bash
git add frontend/src/lib/ratings/presentation.ts core/test/ratings-presentation.test.ts package.json
git commit -m "Décider ce qu'un écran montre quand il n'y a pas de cote"
```

---

### Task 4 : Le client, avec l'échec visible

**Files:**
- Create: `frontend/src/lib/api/ratings.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RankedPlayer { userId: string; pseudo: string; discriminator: string; avatar: string | null; rating: number; matches: number }
  export interface PlayedRow { id: string; playedAt: number; winner: 0 | 1 | 2; p1: Side | null; p2: Side | null; p1Health: number; p2Health: number }
  export type RatingsFailure = 'sessionExpired' | 'failedToLoadRatings';
  export type RankingResult = { ok: true; players: RankedPlayer[] } | { ok: false; reason: RatingsFailure };
  export type MatchesResult = { ok: true; matches: PlayedRow[] } | { ok: false; reason: RatingsFailure };
  export function fetchRanking(crc32: string): Promise<RankingResult>;
  export interface PlayerStanding { userId: string; pseudo: string; discriminator: string; avatar: string | null; isAnonymous: boolean; rating: number | null; matches: number | null }
  export type StandingsResult = { ok: true; standings: PlayerStanding[] } | { ok: false; reason: RatingsFailure };
  export function fetchStandings(crc32: string, userIds: string[]): Promise<StandingsResult>;
  export function fetchMatches(crc32: string): Promise<MatchesResult>;
  ```

- [ ] **Step 1 : Écrire le module**

Pas de test propre : ce fichier n'est que du `fetch` et une union, et sa règle —
« un échec n'est pas une liste vide » — est portée par le **type**, que
`svelte-check` vérifie. Le module est petit et son en-tête dit pourquoi il
existe.

Créer `frontend/src/lib/api/ratings.ts` :

```ts
/**
 * Lire le classement et l'historique, avec l'échec gardé visible.
 *
 * Le résultat est une union discriminée, et c'est la leçon de
 * `frontend/src/lib/saves/api.ts` : une version antérieure de ce patron
 * traitait « je n'ai pas pu demander » comme « il n'y en a pas », et une
 * session expirée produisait une liste vide, aucune erreur, et une sauvegarde
 * qui en écrasait une autre parce que le formulaire croyait le slot libre.
 *
 * Ici la conséquence serait plus douce et tout aussi fausse : un classement
 * vide parce que le réseau a hoqueté se lirait comme un classement vide parce
 * que personne n'a joué. L'union est ce qui interdit à un appelant de sauter le
 * cas d'échec par accident.
 */

export interface RankedPlayer {
  userId: string;
  pseudo: string;
  discriminator: string;
  avatar: string | null;
  rating: number;
  matches: number;
}

export interface PlayedSide {
  userId: string;
  pseudo: string;
  discriminator: string;
}

export interface PlayedRow {
  id: string;
  playedAt: number;
  winner: 0 | 1 | 2;
  p1: PlayedSide | null;
  p2: PlayedSide | null;
  p1Health: number;
  p2Health: number;
}

/** La clé de traduction qui dit pourquoi la lecture n'a pas eu lieu. */
export type RatingsFailure = 'sessionExpired' | 'failedToLoadRatings';

export type RankingResult =
  | { ok: true; players: RankedPlayer[] }
  | { ok: false; reason: RatingsFailure };

export type MatchesResult =
  | { ok: true; matches: PlayedRow[] }
  | { ok: false; reason: RatingsFailure };

/** 401 est « reconnectez-vous » ; tout le reste est « ça n'a pas marché ». */
function reasonFor(status: number): RatingsFailure {
  return status === 401 ? 'sessionExpired' : 'failedToLoadRatings';
}

async function get<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; reason: RatingsFailure }> {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, reason: reasonFor(res.status) };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, reason: 'failedToLoadRatings' };
  }
}

export async function fetchRanking(crc32: string): Promise<RankingResult> {
  const res = await get<RankedPlayer[]>(`/api/ratings/${crc32}`);
  return res.ok ? { ok: true, players: res.data } : res;
}

/** Un joueur du salon, classé ou non, invité ou non. */
export interface PlayerStanding {
  userId: string;
  pseudo: string;
  discriminator: string;
  avatar: string | null;
  isAnonymous: boolean;
  rating: number | null;
  matches: number | null;
}

export type StandingsResult =
  | { ok: true; standings: PlayerStanding[] }
  | { ok: false; reason: RatingsFailure };

export async function fetchStandings(crc32: string, userIds: string[]): Promise<StandingsResult> {
  if (userIds.length === 0) return { ok: true, standings: [] };
  const query = encodeURIComponent(userIds.join(','));
  const res = await get<PlayerStanding[]>(`/api/ratings/${crc32}?users=${query}`);
  return res.ok ? { ok: true, standings: res.data } : res;
}

export async function fetchMatches(crc32: string): Promise<MatchesResult> {
  const res = await get<PlayedRow[]>(`/api/ratings/${crc32}/matches`);
  return res.ok ? { ok: true, matches: res.data } : res;
}
```

- [ ] **Step 2 : Vérifier les types**

Run: `cd frontend && bun run check`
Expected: aucune erreur nouvelle dans ce fichier.

- [ ] **Step 3 : Commit**

```bash
git add frontend/src/lib/api/ratings.ts
git commit -m "Lire les classements sans confondre l'échec avec le vide"
```

---

### Task 5 : Les deux cotes dans le salon

**Files:**
- Modify: `frontend/src/lib/components/RoomPlayers.svelte`
- Modify: `frontend/src/lib/i18n/translations.ts`

**Interfaces:**
- Consumes: `ratingDisplay` (Task 3), `fetchStandings` (Task 4), `watcherFor` de `$lib/games/match-watch`.

- [ ] **Step 1 : Les chaînes, dans les deux langues**

Dans `frontend/src/lib/i18n/translations.ts`, ajouter aux blocs `en` (l. 2) et
`fr` (l. 638) :

| clé | en | fr |
|---|---|---|
| `unranked` | `Unranked` | `Non classé` |
| `guestPlayer` | `Guest` | `Invité` |
| `ratingWithMatches` | `{rating} · {matches} matches` | `{rating} · {matches} parties` |
| `seeRanking` | `See the ranking` | `Voir le classement` |
| `ranking` | `Ranking` | `Classement` |
| `matchHistory` | `Recent matches` | `Parties récentes` |
| `noMatchesYet` | `No match recorded yet.` | `Aucune partie enregistrée pour l’instant.` |
| `failedToLoadRatings` | `Could not load the ranking.` | `Le classement n’a pas pu être chargé.` |
| `ratingsSessionExpired` | `Your session has expired, so the ranking could not be loaded. Sign in again to see it.` | `Votre session a expiré, le classement n’a donc pas pu être chargé. Reconnectez-vous pour le voir.` |

**Ne PAS réutiliser la clé `sessionExpired` qui existe déjà** : son texte dit
« vos sauvegardes n'ont donc pas pu être chargées », ce qui serait faux ici. Une
clé dont le message ment est pire qu'une clé de plus.

`core/test/i18n-parity.test.ts` échoue si une clé n'existe que d'un côté.

- [ ] **Step 2 : Charger les cotes**

Dans le `<script>` de `RoomPlayers.svelte` :

```ts
  import { watcherFor } from '$lib/games/match-watch';
  import { ratingDisplay } from '$lib/ratings/presentation';
  import { fetchStandings, type PlayerStanding } from '$lib/api/ratings';

  let standings: PlayerStanding[] = [];

  /** Le jeu du salon est-il un de ceux dont on sait lire le résultat. */
  $: watched = Boolean(room?.gameCrc32 && watcherFor(room.gameCrc32));

  /*
   * Rechargé quand le jeu ou les occupants changent, et à ce moment-là
   * seulement : les cotes ne bougent qu'entre deux parties, et `room:updated`
   * arrive à chaque clic de siège.
   */
  $: void loadStandings(room?.gameCrc32, player1?.userId, player2?.userId);

  async function loadStandings(crc32?: string, a?: string, b?: string) {
    if (!crc32 || !watched) { standings = []; return; }
    const res = await fetchStandings(crc32, [a, b].filter(Boolean) as string[]);
    // Un échec laisse la liste précédente plutôt que de l'effacer : une cote
    // déjà affichée ne doit pas disparaître pour un hoquet réseau.
    if (res.ok) standings = res.standings;
  }

  /** La ligne de ce joueur, ou undefined tant qu'elle n'est pas arrivée. */
  const standingOf = (userId?: string) => standings.find((s) => s.userId === userId);

  $: display1 = ratingDisplay({
    gameCrc32: room?.gameCrc32, watched, standing: standingOf(player1?.userId)
  });
  $: display2 = ratingDisplay({
    gameCrc32: room?.gameCrc32, watched, standing: standingOf(player2?.userId)
  });
```

- [ ] **Step 3 : Les afficher, et poser le lien SOUS les boutons**

Dans chaque siège, après `<span class="player-name">` :

```svelte
    {#if display1.kind === 'rated'}
      <span class="player-rating">
        {t($language, 'ratingWithMatches', { rating: display1.rating, matches: display1.matches })}
      </span>
    {:else if display1.kind === 'unranked'}
      <span class="player-rating muted">{t($language, 'unranked')}</span>
    {:else if display1.kind === 'guest'}
      <span class="player-rating muted">{t($language, 'guestPlayer')}</span>
    {/if}
```

et l'équivalent avec `display2` dans le second siège.

**Le lien va APRÈS `</div>` de `.players`, jamais à l'intérieur d'un siège.**
Chaque siège est un `<button>` ; un `<a>` imbriqué est du HTML invalide, que
`svelte-check` signale, et son clic serait ambigu — choisir le siège, ou partir
au classement ?

```svelte
{#if watched && room?.gameCrc32}
  <a class="ranking-link" href={`/classement/${room.gameCrc32}`}>
    {t($language, 'seeRanking')}
  </a>
{/if}
```

Ajouter les deux règles de style à la fin du `<style>`, sur le modèle de
`.host-note` pour `.player-rating` et `.muted`.

- [ ] **Step 4 : Vérifier**

Run: `bun run test:ui` puis `cd frontend && bun run check`
Expected: PASS, et **zéro avertissement a11y nouveau** — c'est ce qui prouve que
le lien n'est pas imbriqué dans un bouton.

- [ ] **Step 5 : Commit**

```bash
git add frontend/src/lib/components/RoomPlayers.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Montrer les deux cotes avant de lancer la partie"
```

---

### Task 6 : L'écran complet, et le chemin du retour

**Files:**
- Create: `frontend/src/routes/classement/[crc32]/+page.ts`
- Create: `frontend/src/routes/classement/[crc32]/+page.svelte`
- Modify: `frontend/src/lib/nav/way-back.ts`
- Modify: `core/test/way-back.test.ts`

**Interfaces:**
- Consumes: `fetchRanking`, `fetchMatches` (Task 4) ; les clés i18n (Task 5).

- [ ] **Step 1 : Écrire le test du retour, qui échoue**

À ajouter à `core/test/way-back.test.ts` :

```ts
test('le classement porte un lien de retour, ses sous-chemins compris', () => {
  assert.deepEqual(wayBack('/classement/8F24F886'), { href: '/', label: 'backToLibrary' });
  assert.deepEqual(wayBack('/classement/8F24F886/'), { href: '/', label: 'backToLibrary' });
});

test('le préfixe ne déborde pas sur une route qui lui ressemble', () => {
  // `/classements` n existe pas, mais un `startsWith('/classement')` nu
  // l accepterait - et c est le genre de règle qu on écrit une fois et qu on
  // ne relit jamais.
  assert.equal(wayBack('/classements'), null);
  assert.equal(wayBack('/classementsuite'), null);
});

test('le salon n en a toujours pas', () => {
  assert.equal(wayBack('/room/abc'), null);
});
```

- [ ] **Step 2 : Lancer et vérifier l'échec**

Run: `bun test core/test/way-back.test.ts`
Expected: FAIL — `wayBack('/classement/8F24F886')` rend `null`.

- [ ] **Step 3 : La règle de préfixe**

Dans `frontend/src/lib/nav/way-back.ts`, sous `PLAIN_NAVIGATION` :

```ts
/**
 * Les écrans dont le chemin porte un paramètre.
 *
 * `PLAIN_NAVIGATION` compare des chemins exacts, ce qui suffisait tant que tous
 * les écrans concernés étaient fixes. Le classement est `/classement/<crc32>` :
 * il lui faut un préfixe, et un préfixe comparé sur les SEGMENTS - un
 * `startsWith('/classement')` nu accepterait `/classements`, une route qui
 * n'existe pas aujourd'hui et qui existera peut-être demain.
 */
const PLAIN_NAVIGATION_PREFIXES = ['/classement'];
```

et dans `wayBack` :

```ts
export function wayBack(pathname: string): WayBack | null {
	const path = normalise(pathname ?? '');
	const plain =
		PLAIN_NAVIGATION.has(path) ||
		PLAIN_NAVIGATION_PREFIXES.some((prefix) => path.startsWith(`${prefix}/`));
	if (!plain) return null;
	return { href: '/', label: 'backToLibrary' };
}
```

- [ ] **Step 4 : Lancer et vérifier le succès**

Run: `bun test core/test/way-back.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5 : La route**

Créer `frontend/src/routes/classement/[crc32]/+page.ts` :

```ts
/*
 * `prerender = false`, comme `/room/[id]`, et c'est délibéré.
 *
 * `+layout.ts` pose `prerender = true` pour tout le monde, et
 * `svelte.config.js` exige alors que chaque route prérendue soit nommée dans
 * `prerender.entries` - son commentaire raconte les deux fois où l'oubli a
 * cassé le déploiement. Rien dans la boucle locale ne l'attrape. Une route
 * dynamique servie par le fallback SPA échappe à ce piège par construction.
 */
export const prerender = false;

export function load({ params }) {
  return { crc32: params.crc32 };
}
```

Créer `frontend/src/routes/classement/[crc32]/+page.svelte` :

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import {
    fetchRanking, fetchMatches,
    type RankedPlayer, type PlayedRow, type RatingsFailure
  } from '$lib/api/ratings';

  export let data: { crc32: string };

  /*
   * Trois états, pas deux. « Pas encore chargé », « chargé et vide » et
   * « n'a pas pu être chargé » se dessinent différemment : confondre les deux
   * derniers ferait lire un hoquet réseau comme « personne n'a jamais joué »,
   * ce que l'union discriminée de `api/ratings.ts` existe pour empêcher.
   */
  let players: RankedPlayer[] | null = null;
  let matches: PlayedRow[] | null = null;
  let failure: RatingsFailure | null = null;

  onMount(async () => {
    const [ranking, history] = await Promise.all([
      fetchRanking(data.crc32),
      fetchMatches(data.crc32)
    ]);
    if (!ranking.ok) failure = ranking.reason;
    else players = ranking.players;
    if (!history.ok) failure ??= history.reason;
    else matches = history.matches;
  });

  /** Le vainqueur d'une ligne, dit avec un nom plutôt qu'un numéro de port. */
  function winnerOf(row: PlayedRow): string {
    if (row.winner === 0) return t($language, 'matchDrawn');
    const side = row.winner === 1 ? row.p1 : row.p2;
    return side ? side.pseudo : t($language, 'guestPlayer');
  }

  /** Un joueur d'une ligne, ou le mot qui remplace son absence. */
  function nameOf(side: PlayedRow['p1']): string {
    return side ? `${side.pseudo}#${side.discriminator}` : t($language, 'guestPlayer');
  }

  function when(at: number): string {
    return new Date(at).toLocaleString($language, { dateStyle: 'short', timeStyle: 'short' });
  }
</script>

<h1>{t($language, 'ranking')}</h1>

{#if failure}
  <!-- `ratingsSessionExpired` et non `sessionExpired` : celle-ci parle des
       sauvegardes, et afficherait un message faux sur cet écran. -->
  <p class="failure">
    {t($language, failure === 'sessionExpired' ? 'ratingsSessionExpired' : 'failedToLoadRatings')}
  </p>
{/if}

{#if players}
  {#if players.length === 0}
    <p class="muted">{t($language, 'noMatchesYet')}</p>
  {:else}
    <ol class="ranking">
      {#each players as player, i}
        <li>
          <span class="rank">{i + 1}</span>
          {#if player.avatar}<img src={player.avatar} alt="" class="avatar" />{/if}
          <span class="name">{player.pseudo}#{player.discriminator}</span>
          <!-- `matches` à côté de la cote, et pas en petit : sans seuil
               d'entrée, un joueur à une victoire est en tête, et c'est ce
               nombre qui permet de le lire comme tel. -->
          <span class="rating">
            {t($language, 'ratingWithMatches', { rating: player.rating, matches: player.matches })}
          </span>
        </li>
      {/each}
    </ol>
  {/if}
{/if}

<h2>{t($language, 'matchHistory')}</h2>

{#if matches}
  {#if matches.length === 0}
    <p class="muted">{t($language, 'noMatchesYet')}</p>
  {:else}
    <ul class="matches">
      {#each matches as row}
        <li>
          <span class="when">{when(row.playedAt)}</span>
          <span class="who">{nameOf(row.p1)} — {nameOf(row.p2)}</span>
          <span class="winner">{winnerOf(row)}</span>
        </li>
      {/each}
    </ul>
  {/if}
{/if}
```

Le style suit celui des autres écrans : `var(--panel)` pour les fonds, et la
même classe `.muted` que le salon. `matchDrawn` existe déjà dans les deux
langues (l. 517 et l. 1120) — le réutiliser, ne pas en créer un doublon.

- [ ] **Step 6 : Vérifier, et CONSTRUIRE**

Run: `bun run test:ui`, puis `cd frontend && bun run check`, puis
**obligatoirement** `cd frontend && bun run build`.
Expected: tout au vert. Le build est la seule chose qui prouve qu'une route
neuve ne casse pas le déploiement ; `test:all` ne construit rien.

- [ ] **Step 7 : Commit**

```bash
git add frontend/src/routes/classement frontend/src/lib/nav/way-back.ts core/test/way-back.test.ts
git commit -m "Donner un écran au classement, et un chemin pour en revenir"
```

---

### Task 7 : Dire que le classement est visible des autres

**Files:**
- Modify: `frontend/src/lib/docs/content.ts`

- [ ] **Step 1 : Compléter la section RGPD, dans les deux langues**

La section `privacy` compte **7 paragraphes de chaque côté** et
`core/test/docs-content.test.ts` compare ce nombre : toute phrase ajoutée d'un
côté doit l'être de l'autre.

Le paragraphe qui décrit les parties enregistrées dit ce qui est *conservé* ; il
lui manque ce qui est *montré*. Y ajouter, en français :

> Le classement d’un jeu est visible de tout joueur connecté : il montre le
> pseudonyme, la cote et le nombre de parties de chacun. Rien de sensible n’y
> figure — ni adresse e-mail ni nom réel n’existent dans cette base — mais c’est
> le premier endroit d’où la liste des joueurs peut être parcourue, et non
> seulement consultée joueur par joueur.

et en anglais :

> A game's ranking is visible to any signed-in player: it shows everyone's
> pseudonym, rating and number of matches. Nothing sensitive is in it — neither
> an email address nor a real name exists in this database — but it is the first
> place from which the list of players can be browsed, rather than looked up one
> player at a time.

Faire passer la date de mise à jour à `18 septembre 2026` / `18 September 2026`
dans les deux blocs si elle ne l'est pas déjà.

Ajouter enfin, à la liste de l'en-tête du fichier qui cite le code prouvant
chaque affirmation, la ligne correspondante :

```
 * - « le classement est visible de tout joueur connecté » :
 *   `backend/src/api/ratings.ts` porte `requireAuth`, et son montage dans
 *   `backend/src/bootstrap/app.ts` ajoute `requirePseudo`.
```

- [ ] **Step 2 : Vérifier la parité**

Run: `bun test core/test/docs-content.test.ts core/test/i18n-parity.test.ts`
Expected: PASS.

- [ ] **Step 3 : Relire le rendu, pas le diff**

Afficher les deux sections `privacy` et les lire : c'est ce que l'utilisateur
lira, et une phrase juste dans un diff peut mal tomber dans un paragraphe.

- [ ] **Step 4 : Commit**

```bash
git add frontend/src/lib/docs/content.ts
git commit -m "Dire que le classement est visible des autres joueurs"
```

---

## Vérification finale

- [ ] `bun run test:all` passe.
- [ ] Le **nombre de fichiers** de `test:ui` a augmenté de un
      (`ratings-presentation.test.ts`), et celui de `test:backend` aussi
      (`ratings-read.test.ts`).
- [ ] `cd frontend && bun run build` réussit. `test:all` ne construit rien, et
      c'est le seul garde-fou de la route neuve.
- [ ] `cd frontend && bun run check` ne signale **aucun avertissement a11y
      nouveau** — la preuve que le lien du classement n'est pas imbriqué dans un
      bouton de siège.
- [ ] Dans un vrai salon, sur la ROM mesurée : les deux cotes s'affichent, le
      lien mène au classement, et une partie jouée apparaît dans l'historique.
      **C'est la vérification qui a motivé tout ce chantier** ; aucune suite ne
      la remplace.
