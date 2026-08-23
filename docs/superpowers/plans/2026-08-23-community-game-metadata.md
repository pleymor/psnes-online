# Compléter le catalogue à plusieurs — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un joueur dont la ROM n'est reconnue par rien peut la rattacher à une entrée du catalogue ou en créer une, et la correction sert immédiatement à tous les autres joueurs qui possèdent le même dump.

**Architecture:** Une table `GameMetadataChecksum` fait de la liaison CRC32 → entrée un fait global, résolu par un `LEFT JOIN` à chaque lecture de la bibliothèque plutôt que recopié dans les lignes `Game`. Une colonne `source` sur `GameMetadata` distingue les 94 lignes du catalogue JSON — que le refresh réécrit — des lignes apportées par les joueurs, qu'il doit laisser intactes. Les jaquettes sont des BLOB dans SQLite, servis par une route dédiée.

**Tech Stack:** TypeScript, Express 4, better-sqlite3 12.9.0 (synchrone, pas de `await` dans une transaction), SvelteKit, `node:test` + `node:assert/strict`, Playwright pour l'e2e.

**Spec:** `docs/superpowers/specs/2026-08-23-community-game-metadata-design.md`

## Global Constraints

- **Node**, pas Bun, pour lancer quoi que ce soit : `bare npm` est le npm Windows et échoue sur le chemin UNC. Utiliser le npm du répertoire nvm.
- **Les dates sont des entiers sur le disque** — millisecondes depuis l'epoch — et des `Date` dans les types. La conversion vit dans le convertisseur de ligne de chaque module de dépôt, nulle part ailleurs (`backend/src/db/types.ts`).
- **`undefined` ne peut pas être lié comme paramètre** par better-sqlite3 : il lève. Tout champ optionnel est normalisé en `null` avant d'atteindre une requête.
- **Aucune migration ne contient de `PRAGMA`** : `migrate.ts:assertNoPragma` la refuse avant de l'exécuter.
- **`ADD COLUMN` porteur d'un `REFERENCES` doit avoir `DEFAULT NULL`**, les clés étrangères étant actives (`db/sqlite.ts:19`).
- **Pas de transaction better-sqlite3 à cheval sur un `await`** : lire les octets d'abord, ouvrir la transaction ensuite.
- **Les commentaires de code sont en anglais**, comme tout le dépôt. Les messages de commit aussi.
- **Chaque nouvelle clé i18n existe dans les deux dictionnaires**, `en` et `fr`, dans `frontend/src/lib/i18n/translations.ts`.
- **Lancer les tests backend** : `npm run test:backend`. **Front pur** : `npm run test:ui`. **E2E** : `npm run test:e2e`.
- **Ne jamais `git add -A`** : d'autres sessions partagent l'arbre de travail. Indexer par chemin.

---

### Task 1: La migration et la provenance du catalogue

Le socle. À la fin de cette tâche, un refresh du catalogue ne peut plus effacer une contribution — avant même qu'il soit possible d'en faire une.

**Files:**
- Create: `backend/migrations/0003_community_metadata.sql`
- Modify: `backend/src/db/types.ts` (interface `GameMetadata`)
- Modify: `backend/src/db/game-metadata.ts`
- Modify: `backend/src/services/metadata-loader.ts:74,223` et export de `normalizeTitle`
- Test: `backend/test/game-metadata.test.ts`, `backend/test/migrate.test.ts` (vérification seule)

**Interfaces:**
- Consumes: rien.
- Produces:
  - `type MetadataSource = 'catalogue' | 'community'`
  - `GameMetadata` gagne `source: MetadataSource`, `contributedBy: string | null`, `hasCover: boolean`
  - `countGameMetadata(db: Database, source?: MetadataSource): number`
  - `deleteCatalogueMetadata(db: Database): void` — remplace `deleteAllGameMetadata`
  - `invalidateMetadataCache(): void` depuis `services/metadata-loader.js`
  - `normalizeTitle(title: string): string` — désormais exporté depuis `services/metadata-loader.js`

- [ ] **Step 1: Écrire les tests qui échouent**

Dans `backend/test/game-metadata.test.ts`, ajouter à la fin du fichier :

```typescript
test('the catalogue count ignores what players contributed', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, [ENTRY]);
  db.prepare(`
    INSERT INTO "GameMetadata" (id, title, source, createdAt, updatedAt)
    VALUES ('c1', 'A game a player added', 'community', 0, 0)
  `).run();

  assert.equal(countGameMetadata(db), 2, 'without an argument, everything is counted');
  assert.equal(countGameMetadata(db, 'catalogue'), 1);
  assert.equal(countGameMetadata(db, 'community'), 1);
});

test('a batch insert is catalogue-owned by default', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, [ENTRY]);

  const [listed] = listGameMetadata(db);
  assert.equal(listed.source, 'catalogue');
  assert.equal(listed.contributedBy, null);
  assert.equal(listed.hasCover, false);
});

test('deleting the catalogue leaves the community rows standing', () => {
  const db = migratedDb();
  insertGameMetadataBatch(db, [ENTRY]);
  db.prepare(`
    INSERT INTO "GameMetadata" (id, title, source, createdAt, updatedAt)
    VALUES ('c1', 'A game a player added', 'community', 0, 0)
  `).run();

  // This is the whole point of the source column: refreshGameMetadata wipes
  // and reloads the JSON catalogue, and a contribution must survive it.
  deleteCatalogueMetadata(db);

  const remaining = listGameMetadata(db);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].title, 'A game a player added');
});

test('listing the catalogue does not carry the cover bytes', () => {
  const db = migratedDb();
  db.prepare(`
    INSERT INTO "GameMetadata" (id, title, source, cover, coverMime, createdAt, updatedAt)
    VALUES ('c1', 'With a cover', 'community', ?, 'image/webp', 0, 0)
  `).run(Buffer.alloc(64 * 1024, 7));

  const [listed] = listGameMetadata(db);

  // listGameMetadata is what fills metadataCache. A SELECT * would keep every
  // cover in memory and re-read them all on each invalidation, so the absence
  // of the bytes is the assertion, not an implementation detail.
  assert.equal(listed.hasCover, true, 'the presence of a cover is still reported');
  assert.equal((listed as Record<string, unknown>).cover, undefined);
});
```

Ajouter `deleteCatalogueMetadata` à l'import en tête du fichier et retirer `deleteAllGameMetadata`. Dans le test existant `un catalogue vidé se recharge` (ou tout autre test citant `deleteAllGameMetadata`), remplacer l'appel par `deleteCatalogueMetadata`.

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

Run: `npm run test:backend`
Expected: FAIL — `deleteCatalogueMetadata is not a function`, et `listed.source` vaut `undefined`.

- [ ] **Step 3: Écrire la migration**

Créer `backend/migrations/0003_community_metadata.sql` :

```sql
-- Community contributions to the shared catalogue.
--
-- Two things are added here. First, provenance on "GameMetadata": the JSON
-- catalogue owns the rows it shipped and rewrites them wholesale on every
-- refresh, so a row a player contributed has to be distinguishable from one
-- the file owns, or the next refresh deletes it. Second, the link table, which
-- is what actually carries a contribution to other players.
--
-- The DEFAULT NULL on contributedBy is not stylistic: SQLite refuses an
-- ADD COLUMN carrying a REFERENCES clause unless its default is NULL, and
-- foreign keys are enabled (db/sqlite.ts: pragma foreign_keys = ON).
--
-- createdAt keeps the baseline's DATETIME DEFAULT CURRENT_TIMESTAMP for
-- consistency with every other table here, but nothing relies on it: the code
-- always writes an explicit Date.now(), because every date in this schema is
-- stored as milliseconds since the epoch.

ALTER TABLE "GameMetadata" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'catalogue';
ALTER TABLE "GameMetadata" ADD COLUMN "contributedBy" TEXT DEFAULT NULL REFERENCES "User" ("id") ON DELETE SET NULL;
ALTER TABLE "GameMetadata" ADD COLUMN "cover" BLOB;
ALTER TABLE "GameMetadata" ADD COLUMN "coverMime" TEXT;

-- crc32 is the primary key, and that is the load-bearing decision: a CRC32
-- names an exact dump, so it belongs to at most one game. The link is
-- idempotent for free, and two players cannot attach the same ROM to two
-- different entries -- the schema refuses it, rather than an application guard
-- that would eventually be forgotten.
CREATE TABLE "GameMetadataChecksum" (
    "crc32" TEXT NOT NULL PRIMARY KEY,
    "metadataId" TEXT NOT NULL,
    "contributedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GameMetadataChecksum_metadataId_fkey" FOREIGN KEY ("metadataId") REFERENCES "GameMetadata" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GameMetadataChecksum_contributedBy_fkey" FOREIGN KEY ("contributedBy") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "GameMetadataChecksum_metadataId_idx" ON "GameMetadataChecksum" ("metadataId");
CREATE INDEX "GameMetadata_source_idx" ON "GameMetadata" ("source");
```

- [ ] **Step 4: Étendre le type**

Dans `backend/src/db/types.ts`, au-dessus de `GameMetadata` :

```typescript
/** Who owns a catalogue row: the shipped JSON file, or a player. */
export type MetadataSource = 'catalogue' | 'community';
```

Puis, dans l'interface `GameMetadata`, après `md5`:

```typescript
  source: MetadataSource;
  contributedBy: string | null;
  /**
   * Whether a cover image is stored. The bytes themselves never travel with
   * the row: they are megabytes in aggregate and only the cover route wants
   * them.
   */
  hasCover: boolean;
```

- [ ] **Step 5: Adapter le dépôt**

Dans `backend/src/db/game-metadata.ts` :

Remplacer l'import de type par `import type { GameMetadata, MetadataSource } from './types.js';`

Ajouter, sous les imports :

```typescript
/**
 * Every column except `cover`.
 *
 * `SELECT *` would pull the cover bytes into every read, and this module's
 * `listGameMetadata` is what fills the in-memory catalogue cache -- so a star
 * there means holding every cover in memory and re-reading them all on each
 * invalidation. The bytes leave only through `findCover`.
 */
const COLUMNS = `
  id, title, altTitle, genre, publisher, developer, releaseDate, players,
  region, description, coverUrl, crc32, md5, source, contributedBy,
  coverMime, createdAt, updatedAt
`;
```

Étendre `MetadataRow` :

```typescript
interface MetadataRow extends Omit<GameMetadata, 'createdAt' | 'updatedAt' | 'hasCover'> {
  createdAt: number;
  updatedAt: number;
  coverMime: string | null;
}
```

Dans `toMetadata`, après `md5: row.md5,` :

```typescript
    source: row.source,
    contributedBy: row.contributedBy,
    hasCover: row.coverMime !== null,
```

Remplacer `countGameMetadata`, `listGameMetadata`, `findGameMetadataByChecksum` et `deleteAllGameMetadata` :

```typescript
export function countGameMetadata(db: Database, source?: MetadataSource): number {
  const row = source
    ? db.prepare(`SELECT COUNT(*) AS n FROM "GameMetadata" WHERE source = ?`).get(source)
    : db.prepare(`SELECT COUNT(*) AS n FROM "GameMetadata"`).get();
  return (row as { n: number }).n;
}

export function listGameMetadata(db: Database): GameMetadata[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM "GameMetadata"`).all() as MetadataRow[];
  return rows.map(toMetadata);
}

export function findGameMetadataByChecksum(db: Database, checksum: string): GameMetadata | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM "GameMetadata" WHERE crc32 = ? OR md5 = ?`)
    .get(checksum, checksum) as MetadataRow | undefined;
  return row ? toMetadata(row) : null;
}

/**
 * Drops the rows the JSON file owns, and only those.
 *
 * The refresh path deletes the catalogue and reinserts it from the file. Before
 * the source column existed this was an unqualified DELETE, so anything a
 * player had contributed vanished on the next refresh.
 */
export function deleteCatalogueMetadata(db: Database): void {
  db.prepare(`DELETE FROM "GameMetadata" WHERE source = 'catalogue'`).run();
}
```

- [ ] **Step 6: Corriger les invariants du chargeur**

Dans `backend/src/services/metadata-loader.ts` :

- ligne 7 de l'import : `deleteAllGameMetadata` → `deleteCatalogueMetadata` ;
- ligne 74 : `const existingCount = countGameMetadata(db, 'catalogue');` — et dans le log au-dessus du `return`, préciser `'Catalogue already loaded, skipping'`. Une base neuve dont la lecture du JSON a échoué mais où un joueur a contribué verrait sinon « 1 » et sauterait le chargement du catalogue à jamais ;
- ligne 223 : `deleteAllGameMetadata(db)` → `deleteCatalogueMetadata(db)` ;
- rendre `normalizeTitle` exporté : `export function normalizeTitle(title: string): string {` ;
- ajouter, après la déclaration de `metadataCache` :

```typescript
/**
 * Forgets the cached catalogue, so the next read rebuilds it.
 *
 * The cache feeds both the title matcher and the contribution search. Without
 * this, an entry a player just created would not exist until the container
 * restarted.
 */
export function invalidateMetadataCache(): void {
  metadataCache = null;
}

/** The catalogue as the search and the title matcher see it, loading it on first use. */
export function cachedCatalogue(): GameMetadata[] {
  if (!metadataCache) metadataCache = listGameMetadata(getDb());
  return metadataCache;
}
```

Ajouter `import type { GameMetadata } from '../db/types.js';` en tête, et remplacer le type de `metadataCache` par `GameMetadata[] | null` au lieu de `any[] | null`. Dans `findGameMetadata`, remplacer les deux lignes de chargement paresseux par `const allMetadata = cachedCatalogue();`.

- [ ] **Step 7: Lancer les tests**

Run: `npm run test:backend`
Expected: PASS, y compris `backend/test/migrate.test.ts` et `backend/test/metadata-loader.test.ts` qui ne devaient pas bouger.

- [ ] **Step 8: Commit**

```bash
git add backend/migrations/0003_community_metadata.sql backend/src/db/types.ts backend/src/db/game-metadata.ts backend/src/services/metadata-loader.ts backend/test/game-metadata.test.ts
git commit -m "Let the catalogue tell its own rows from a player's"
```

---

### Task 2: Le dépôt des contributions

Les écritures : créer une entrée communautaire, poser une liaison, déposer une jaquette.

**Files:**
- Create: `backend/src/db/metadata-links.ts`
- Modify: `backend/src/db/game-metadata.ts`
- Test: `backend/test/metadata-contrib.test.ts` (create)

**Interfaces:**
- Consumes: `MetadataSource`, `COLUMNS`, `toMetadata` (Task 1).
- Produces:
  - depuis `db/game-metadata.js` : `findGameMetadataById(db, id): GameMetadata | null`, `insertCommunityMetadata(db, entry: CommunityEntryInput, contributedBy: string): GameMetadata`, `setCover(db, metadataId, bytes: Buffer, mime: string): string`, `findCover(db, metadataId): { bytes: Buffer; mime: string } | null`
  - depuis `db/metadata-links.js` : `interface MetadataLink`, `findLinkByChecksum(db, crc32): MetadataLink | null`, `linkChecksum(db, input): MetadataLink`
  - `interface CommunityEntryInput` — tous les champs `string | null` sauf `title: string`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `backend/test/metadata-contrib.test.ts` :

```typescript
/**
 * Contributions to the shared catalogue.
 *
 * What these pin down is that a contribution cannot be lost or duplicated. The
 * link table's primary key is the guard against two players attaching the same
 * dump to two different games, and the cascade rules are what decide whether
 * deleting an account destroys the work it left behind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  findGameMetadataById, insertCommunityMetadata, setCover, findCover,
  listGameMetadata, countGameMetadata
} from '../src/db/game-metadata.js';
import { findLinkByChecksum, linkChecksum } from '../src/db/metadata-links.js';

const EMPTY = {
  altTitle: null, genre: null, publisher: null, developer: null,
  releaseDate: null, players: null, region: null, description: null
};

test('a community entry is stored, attributed and findable', () => {
  const db = migratedDb();
  const user = insertUser(db);

  const created = insertCommunityMetadata(db, { title: 'Umihara Kawase', ...EMPTY }, user.id);

  assert.ok(created.id.length > 0);
  assert.equal(created.source, 'community');
  assert.equal(created.contributedBy, user.id);
  assert.equal(created.hasCover, false);
  assert.equal(findGameMetadataById(db, created.id)!.title, 'Umihara Kawase');
  assert.equal(countGameMetadata(db, 'catalogue'), 0, 'it does not pass for a shipped row');
});

test('every descriptive field is optional', () => {
  const db = migratedDb();
  const user = insertUser(db);

  // The player is asked for nothing but a title, and even that falls back to
  // the filename upstream. undefined would throw on binding, so the input type
  // is null-based throughout.
  const created = insertCommunityMetadata(db, { title: 'Bare', ...EMPTY }, user.id);

  assert.equal(created.genre, null);
  assert.equal(created.description, null);
  assert.equal(created.coverUrl, null);
});

test('a checksum links to an entry and is found again', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Rendering Ranger R2', ...EMPTY }, user.id);

  const link = linkChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: user.id });

  assert.equal(link.metadataId, meta.id);
  assert.ok(link.createdAt instanceof Date);
  assert.equal(findLinkByChecksum(db, 'DEADBEEF')!.metadataId, meta.id);
  assert.equal(findLinkByChecksum(db, 'CAFEBABE'), null);
});

test('one dump cannot belong to two games', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const first = insertCommunityMetadata(db, { title: 'First', ...EMPTY }, user.id);
  const second = insertCommunityMetadata(db, { title: 'Second', ...EMPTY }, user.id);
  linkChecksum(db, { crc32: 'DEADBEEF', metadataId: first.id, contributedBy: user.id });

  // Refused by the primary key, not by an application guard someone could
  // forget to write at the next call site.
  assert.throws(
    () => linkChecksum(db, { crc32: 'DEADBEEF', metadataId: second.id, contributedBy: user.id }),
    /UNIQUE constraint failed/
  );
});

test('deleting an entry takes its links with it', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Doomed', ...EMPTY }, user.id);
  linkChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: user.id });

  db.prepare(`DELETE FROM "GameMetadata" WHERE id = ?`).run(meta.id);

  assert.equal(findLinkByChecksum(db, 'DEADBEEF'), null, 'no link pointing at nothing');
});

test('deleting an account keeps the contribution and drops only the credit', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Survivor', ...EMPTY }, user.id);
  linkChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: user.id });

  db.prepare(`DELETE FROM "User" WHERE id = ?`).run(user.id);

  // The data still serves every other player; only the attribution goes.
  assert.equal(findGameMetadataById(db, meta.id)!.contributedBy, null);
  assert.equal(findLinkByChecksum(db, 'DEADBEEF')!.contributedBy, null);
});

test('a cover survives the round trip and gets a versioned url', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Illustrated', ...EMPTY }, user.id);
  const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);

  const coverUrl = setCover(db, meta.id, bytes, 'image/webp');

  const stored = findCover(db, meta.id)!;
  assert.deepEqual(stored.bytes, bytes);
  assert.equal(stored.mime, 'image/webp');

  // The query string is what lets the response be cached hard: replacing a
  // cover changes the URL, so no client is stuck with the old picture.
  assert.match(coverUrl, new RegExp(`^/api/covers/${meta.id}\\?v=\\d+$`));
  assert.equal(findGameMetadataById(db, meta.id)!.coverUrl, coverUrl);
  assert.equal(findGameMetadataById(db, meta.id)!.hasCover, true);
  assert.equal(findCover(db, 'no-such-entry'), null);
});

test('the listing still refuses to carry cover bytes once one exists', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const meta = insertCommunityMetadata(db, { title: 'Heavy', ...EMPTY }, user.id);
  setCover(db, meta.id, Buffer.alloc(64 * 1024, 7), 'image/png');

  const [listed] = listGameMetadata(db);

  assert.equal(listed.hasCover, true);
  assert.equal((listed as Record<string, unknown>).cover, undefined);
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `npm run test:backend`
Expected: FAIL — `Cannot find module '../src/db/metadata-links.js'`.

- [ ] **Step 3: Étendre `db/game-metadata.ts`**

Ajouter à la fin de `backend/src/db/game-metadata.ts` :

```typescript
/**
 * What a player may fill in.
 *
 * Every field is optional except the title, and even that falls back upstream
 * to the game's current name -- so "all optional" holds without leaving a row
 * with a NULL title, which the column forbids. Nulls rather than optional keys
 * because better-sqlite3 throws on a bound `undefined`.
 */
export interface CommunityEntryInput {
  title: string;
  altTitle: string | null;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
}

export function findGameMetadataById(db: Database, id: string): GameMetadata | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM "GameMetadata" WHERE id = ?`)
    .get(id) as MetadataRow | undefined;
  return row ? toMetadata(row) : null;
}

/**
 * Records an entry a player wrote.
 *
 * `source` is 'community', which is what keeps the JSON refresh from deleting
 * it, and `contributedBy` is what makes a wrong entry traceable later -- the
 * two halves of "immediate, attributed, reversible".
 */
export function insertCommunityMetadata(
  db: Database,
  entry: CommunityEntryInput,
  contributedBy: string
): GameMetadata {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO "GameMetadata" (id, title, altTitle, genre, publisher, developer,
                                releaseDate, players, region, description, coverUrl,
                                crc32, md5, source, contributedBy, createdAt, updatedAt)
    VALUES (@id, @title, @altTitle, @genre, @publisher, @developer,
            @releaseDate, @players, @region, @description, NULL,
            NULL, NULL, 'community', @contributedBy, @now, @now)
  `).run({ id, contributedBy, now, ...entry });
  return findGameMetadataById(db, id)!;
}

/**
 * Stores a cover and returns the URL that serves it.
 *
 * The URL carries the write's timestamp. Without it the response could not be
 * cached for long -- replacing a cover would leave every client that had
 * already fetched the old one showing it until the cache expired.
 */
export function setCover(db: Database, metadataId: string, bytes: Buffer, mime: string): string {
  const now = Date.now();
  const coverUrl = `/api/covers/${metadataId}?v=${now}`;
  db.prepare(`UPDATE "GameMetadata" SET cover = ?, coverMime = ?, coverUrl = ?, updatedAt = ? WHERE id = ?`)
    .run(bytes, mime, coverUrl, now, metadataId);
  return coverUrl;
}

/** The only path the cover bytes take out of the database. */
export function findCover(db: Database, metadataId: string): { bytes: Buffer; mime: string } | null {
  const row = db.prepare(`SELECT cover, coverMime FROM "GameMetadata" WHERE id = ?`)
    .get(metadataId) as { cover: Buffer | null; coverMime: string | null } | undefined;
  if (!row || !row.cover || !row.coverMime) return null;
  return { bytes: row.cover, mime: row.coverMime };
}
```

- [ ] **Step 4: Écrire `db/metadata-links.ts`**

```typescript
/**
 * Which dump is which game.
 *
 * A row here says that the ROM whose CRC32 is `crc32` is the game described by
 * `metadataId`. That is a fact about the world rather than a fact about a
 * player, which is exactly why one player posting it serves everyone who owns
 * the same dump -- and why the resolution happens at read time instead of
 * being copied into each player's own Game row.
 */

import type { Database } from './sqlite.js';

export interface MetadataLink {
  crc32: string;
  metadataId: string;
  contributedBy: string | null;
  createdAt: Date;
}

interface LinkRow {
  crc32: string;
  metadataId: string;
  contributedBy: string | null;
  createdAt: number;
}

function toLink(row: LinkRow): MetadataLink {
  return {
    crc32: row.crc32,
    metadataId: row.metadataId,
    contributedBy: row.contributedBy,
    createdAt: new Date(row.createdAt)
  };
}

export function findLinkByChecksum(db: Database, crc32: string): MetadataLink | null {
  const row = db.prepare(`SELECT * FROM "GameMetadataChecksum" WHERE crc32 = ?`)
    .get(crc32) as LinkRow | undefined;
  return row ? toLink(row) : null;
}

/**
 * Claims a checksum for an entry.
 *
 * Throws on a checksum already claimed: `crc32` is the primary key, because a
 * CRC32 names an exact dump and so belongs to at most one game. Callers read
 * the existing link first and turn the collision into an answer the player can
 * act on, rather than letting this throw reach them.
 */
export function linkChecksum(
  db: Database,
  input: { crc32: string; metadataId: string; contributedBy: string | null }
): MetadataLink {
  const now = Date.now();
  db.prepare(`
    INSERT INTO "GameMetadataChecksum" (crc32, metadataId, contributedBy, createdAt)
    VALUES (@crc32, @metadataId, @contributedBy, @now)
  `).run({ ...input, now });
  return findLinkByChecksum(db, input.crc32)!;
}
```

- [ ] **Step 5: Lancer les tests**

Run: `npm run test:backend`
Expected: PASS — les huit tests de `metadata-contrib.test.ts` compris.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/metadata-links.ts backend/src/db/game-metadata.ts backend/test/metadata-contrib.test.ts
git commit -m "Let a player's entry and its dump be written down"
```

---

### Task 3: Résoudre l'identité à la lecture

C'est ici que « tous les joueurs en profitent » devient vrai.

**Files:**
- Create: `backend/src/db/game-identity.ts`
- Create: `backend/test/game-identity.test.ts`
- Modify: `backend/src/db/games.ts:1-30` (types) et `:84-111` (`listGamesWithSaveSummaries`)
- Test: `backend/test/games.test.ts`

**Interfaces:**
- Consumes: la table `GameMetadataChecksum` (Task 1).
- Produces:
  - `interface IdentityFields` — `title` plus les huit colonnes descriptives, toutes `string | null`
  - `mergeIdentity(game: Game, identity: IdentityFields | null): Game`
  - `needsIdentification(game: Game, identity: IdentityFields | null): boolean`
  - `GameWithSaveSummaries` gagne `metadataId: string | null` et `needsIdentification: boolean`

- [ ] **Step 1: Écrire le test des fonctions pures**

Créer `backend/test/game-identity.test.ts` :

```typescript
/**
 * How a game's identity is decided.
 *
 * The asymmetry is the whole content of this module: a CRC32 link is exact
 * evidence a human posted, while the descriptive columns on a Game row are
 * whatever an approximate title match happened to produce. So the catalogue
 * wins field by field -- and only where it actually has something to say.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeIdentity, needsIdentification } from '../src/db/game-identity.js';
import type { Game } from '../src/db/types.js';

const GAME: Game = {
  id: 'g1', title: 'smw.sfc', filename: 'smw.sfc', coverUrl: null,
  uploadedAt: new Date(0), genre: null, publisher: null, developer: null,
  releaseDate: null, players: null, region: null, description: null,
  crc32: 'DEADBEEF', sram: null, sramUpdatedAt: null, userId: 'u1'
};

const IDENTITY = {
  title: 'Super Mario World', genre: 'Platform', publisher: 'Nintendo',
  developer: 'Nintendo EAD', releaseDate: '1990-11-21', players: '2',
  region: 'NTSC', description: 'A platformer.', coverUrl: '/api/covers/m1?v=7'
};

test('with no identity, the game is left exactly as it was', () => {
  assert.deepEqual(mergeIdentity(GAME, null), GAME);
});

test('the catalogue wins field by field', () => {
  const merged = mergeIdentity(GAME, IDENTITY);

  assert.equal(merged.title, 'Super Mario World', 'the filename gives way to the real title');
  assert.equal(merged.genre, 'Platform');
  assert.equal(merged.coverUrl, '/api/covers/m1?v=7');
  assert.equal(merged.crc32, 'DEADBEEF', 'nothing outside the descriptive fields moves');
  assert.equal(merged.filename, 'smw.sfc');
});

test('a hole in the entry falls back to the game row rather than blanking it', () => {
  // A player fills in what they know. An entry with no genre must not erase a
  // genre a title match had already found.
  const guessed: Game = { ...GAME, genre: 'Platform', publisher: 'Nintendo' };

  const merged = mergeIdentity(guessed, { ...IDENTITY, genre: null, publisher: null });

  assert.equal(merged.genre, 'Platform');
  assert.equal(merged.publisher, 'Nintendo');
});

test('an entry with no title at all leaves the game titled as it was', () => {
  const merged = mergeIdentity(GAME, { ...IDENTITY, title: null });
  assert.equal(merged.title, 'smw.sfc');
});

test('a game nothing knows anything about needs identifying', () => {
  assert.equal(needsIdentification(GAME, null), true);
});

test('a linked game never needs identifying, however empty the entry', () => {
  const bare = {
    title: null, genre: null, publisher: null, developer: null, releaseDate: null,
    players: null, region: null, description: null, coverUrl: null
  };
  assert.equal(needsIdentification(GAME, bare), false);
});

test('a game a title match already filled in is left alone', () => {
  // This is what keeps the badge off forty cards that are already fine. It is
  // deliberately generous: one known field is enough to stay quiet.
  const guessed: Game = { ...GAME, genre: 'Platform' };
  assert.equal(needsIdentification(guessed, null), false);
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `npm run test:backend`
Expected: FAIL — `Cannot find module '../src/db/game-identity.js'`.

- [ ] **Step 3: Écrire `db/game-identity.ts`**

```typescript
/**
 * Deciding what a game is, from a row and a catalogue entry.
 *
 * Kept pure and kept apart from db/games.ts on purpose: this is the part that
 * can be wrong without anyone seeing it -- a merge rule that silently blanks a
 * field looks like a working library until someone notices their genres are
 * gone -- and db/games.ts is already 272 lines of row mapping in which a merge
 * rule would read as one more detail.
 */

import type { Game } from './types.js';

/** What a catalogue entry can say about a game. */
export interface IdentityFields {
  title: string | null;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  coverUrl: string | null;
}

/** The columns a catalogue entry may fill in; the title is handled apart, being NOT NULL on Game. */
const DESCRIPTIVE = [
  'genre', 'publisher', 'developer', 'releaseDate',
  'players', 'region', 'description', 'coverUrl'
] as const;

/**
 * The game as it should be shown.
 *
 * The entry wins field by field wherever it has something, the row serving as
 * the fallback. The asymmetry is deliberate: a CRC32 link is exact evidence a
 * human posted, while a Game column holds whatever an approximate title match
 * produced. There is no risk of trampling a player's own wording -- the
 * application has no way to rename a game.
 */
export function mergeIdentity(game: Game, identity: IdentityFields | null): Game {
  if (!identity) return game;
  const merged = { ...game, title: identity.title ?? game.title };
  for (const field of DESCRIPTIVE) {
    merged[field] = identity[field] ?? game[field];
  }
  return merged;
}

/**
 * Whether to ask the player who this is.
 *
 * A linked game never qualifies, however sparse its entry: somebody has
 * already answered the question. Absent a link, one known field is enough to
 * stay quiet -- the point is to catch the games nothing recognised, not to put
 * a badge on forty cards an approximate title match already filled in.
 */
export function needsIdentification(game: Game, identity: IdentityFields | null): boolean {
  if (identity) return false;
  return DESCRIPTIVE.every(field => game[field] === null);
}
```

- [ ] **Step 4: Lancer le test**

Run: `npm run test:backend`
Expected: PASS pour `game-identity.test.ts`.

- [ ] **Step 5: Écrire le test du chemin de lecture**

Dans `backend/test/games.test.ts`, ajouter en fin de fichier. Ajouter aussi `insertCommunityMetadata` et `linkChecksum` aux imports depuis `../src/db/game-metadata.js` et `../src/db/metadata-links.js`.

```typescript
test('the library resolves a game through its checksum link', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, {
    title: 'smw.sfc', filename: 'smw.sfc', crc32: 'DEADBEEF',
    userId: user.id, ...NO_METADATA
  });
  const meta = insertCommunityMetadata(db, {
    title: 'Super Mario World', altTitle: null, genre: 'Platform',
    publisher: 'Nintendo', developer: null, releaseDate: null,
    players: '2', region: null, description: null
  }, user.id);
  linkChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: user.id });

  const [listed] = listGamesWithSaveSummaries(db, user.id);

  // Nothing was written to the Game row: the link is resolved on the way out,
  // which is why a contribution reaches players who added the ROM long ago.
  assert.equal(listed.title, 'Super Mario World');
  assert.equal(listed.genre, 'Platform');
  assert.equal(listed.players, '2');
  assert.equal(listed.metadataId, meta.id);
  assert.equal(listed.needsIdentification, false);
  assert.equal(findGameById(db, game.id)!.title, 'smw.sfc', 'the stored row is untouched');
});

test('another player with the same dump gets the same identity for free', () => {
  const db = migratedDb();
  const one = insertUser(db);
  const two = insertUser(db);
  createGame(db, { title: 'rom.sfc', filename: 'rom.sfc', crc32: 'DEADBEEF', userId: one.id, ...NO_METADATA });
  createGame(db, { title: 'copy.sfc', filename: 'copy.sfc', crc32: 'DEADBEEF', userId: two.id, ...NO_METADATA });

  const meta = insertCommunityMetadata(db, {
    title: 'Rendering Ranger R2', altTitle: null, genre: null, publisher: null,
    developer: null, releaseDate: null, players: null, region: null, description: null
  }, one.id);
  linkChecksum(db, { crc32: 'DEADBEEF', metadataId: meta.id, contributedBy: one.id });

  const [seenByTwo] = listGamesWithSaveSummaries(db, two.id);

  assert.equal(seenByTwo.title, 'Rendering Ranger R2');
  assert.equal(seenByTwo.needsIdentification, false);
});

test('an unrecognised game reports that it needs identifying', () => {
  const db = migratedDb();
  const user = insertUser(db);
  createGame(db, { title: 'unknown.sfc', filename: 'unknown.sfc', crc32: 'CAFEBABE', userId: user.id, ...NO_METADATA });

  const [listed] = listGamesWithSaveSummaries(db, user.id);

  assert.equal(listed.needsIdentification, true);
  assert.equal(listed.metadataId, null);
});

test('a game with no checksum at all is not asked to be identified', () => {
  const db = migratedDb();
  const user = insertUser(db);
  // Pre-local-ROM rows: LinkRom has to attach a checksum before there is
  // anything to identify, so the join cannot match and must not throw either.
  createGame(db, { title: 'Legacy', filename: 'legacy.sfc', crc32: null, userId: user.id, ...NO_METADATA });

  const [listed] = listGamesWithSaveSummaries(db, user.id);

  assert.equal(listed.metadataId, null);
  assert.equal(listed.needsIdentification, true, 'true, but the card shows "ROM to locate" first');
});
```

- [ ] **Step 6: Lancer pour vérifier l'échec**

Run: `npm run test:backend`
Expected: FAIL — `listed.metadataId` vaut `undefined`.

- [ ] **Step 7: Modifier `listGamesWithSaveSummaries`**

Dans `backend/src/db/games.ts`, étendre l'interface (vers la ligne 5) :

```typescript
export interface GameWithSaveSummaries extends Game {
  saves: SaveSummary[];
  /** The catalogue entry this game's dump is linked to, if anyone has said. */
  metadataId: string | null;
  /** Whether to offer the player the chance to say what this game is. */
  needsIdentification: boolean;
}
```

Ajouter l'import : `import { mergeIdentity, needsIdentification, type IdentityFields } from './game-identity.js';`

Remplacer le corps de `listGamesWithSaveSummaries` (ligne 84) jusqu'au `return` final :

```typescript
export function listGamesWithSaveSummaries(db: Database, userId: string): GameWithSaveSummaries[] {
  // The two joins are what make a contribution retroactive: the identity is
  // resolved on the way out rather than copied into the row at creation, so a
  // link posted today reaches a game added a month ago. A NULL g.crc32 matches
  // nothing, which is the correct answer for a row that predates local ROMs.
  const rows = db.prepare(`
    SELECT g.*,
           k.metadataId AS linkedMetadataId,
           m.title AS metaTitle, m.genre AS metaGenre, m.publisher AS metaPublisher,
           m.developer AS metaDeveloper, m.releaseDate AS metaReleaseDate,
           m.players AS metaPlayers, m.region AS metaRegion,
           m.description AS metaDescription, m.coverUrl AS metaCoverUrl
    FROM "Game" g
    LEFT JOIN "GameMetadataChecksum" k ON k.crc32 = g.crc32
    LEFT JOIN "GameMetadata" m ON m.id = k.metadataId
    WHERE g.userId = ?
    ORDER BY g.uploadedAt DESC
  `).all(userId) as (GameRow & {
    linkedMetadataId: string | null;
    metaTitle: string | null; metaGenre: string | null; metaPublisher: string | null;
    metaDeveloper: string | null; metaReleaseDate: string | null; metaPlayers: string | null;
    metaRegion: string | null; metaDescription: string | null; metaCoverUrl: string | null;
  })[];

  if (rows.length === 0) return [];

  const summaries = db.prepare(`
    SELECT id, name, slotNumber, screenshot, createdAt, updatedAt, gameId
    FROM "Save" WHERE gameId IN (${rows.map(() => '?').join(',')})
  `).all(...rows.map(g => g.id)) as (Omit<SaveSummary, 'createdAt' | 'updatedAt'> & {
    createdAt: number; updatedAt: number; gameId: string;
  })[];

  const byGame = new Map<string, SaveSummary[]>();
  for (const s of summaries) {
    const list = byGame.get(s.gameId) ?? [];
    list.push({
      id: s.id,
      name: s.name,
      slotNumber: s.slotNumber,
      screenshot: s.screenshot,
      createdAt: new Date(s.createdAt),
      updatedAt: new Date(s.updatedAt)
    });
    byGame.set(s.gameId, list);
  }

  return rows.map(row => {
    const identity: IdentityFields | null = row.linkedMetadataId === null ? null : {
      title: row.metaTitle,
      genre: row.metaGenre,
      publisher: row.metaPublisher,
      developer: row.metaDeveloper,
      releaseDate: row.metaReleaseDate,
      players: row.metaPlayers,
      region: row.metaRegion,
      description: row.metaDescription,
      coverUrl: row.metaCoverUrl
    };
    const game = toGame(row);
    return {
      ...mergeIdentity(game, identity),
      saves: byGame.get(row.id) ?? [],
      metadataId: row.linkedMetadataId,
      needsIdentification: needsIdentification(game, identity)
    };
  });
}
```

- [ ] **Step 8: Lancer les tests**

Run: `npm run test:backend`
Expected: PASS, y compris les tests existants de `games.test.ts` qui vérifient l'ordre et les résumés de sauvegarde.

- [ ] **Step 9: Commit**

```bash
git add backend/src/db/game-identity.ts backend/src/db/games.ts backend/test/game-identity.test.ts backend/test/games.test.ts
git commit -m "Resolve a game's identity from the dump, not from its row"
```

---

### Task 4: Chercher dans le catalogue

**Files:**
- Create: `backend/src/services/catalogue-search.ts`
- Create: `backend/src/api/metadata.ts`
- Create: `backend/test/catalogue-search.test.ts`
- Modify: `backend/src/index.ts:18,219` (import et montage)

**Interfaces:**
- Consumes: `normalizeTitle`, `cachedCatalogue` (Task 1), `GameMetadata` (Task 1).
- Produces:
  - `interface CatalogueMatch { id, title, altTitle, region, publisher, releaseDate, coverUrl, source }`
  - `SEARCH_LIMIT = 20`
  - `rankCatalogue(entries: GameMetadata[], query: string): CatalogueMatch[]`
  - route `GET /api/metadata/search?q=…`
  - `metadataRouter` exporté depuis `api/metadata.js`

- [ ] **Step 1: Écrire le test**

Créer `backend/test/catalogue-search.test.ts` :

```typescript
/**
 * Finding the entry a player means.
 *
 * The ranking is the whole feature: the client seeds the query with the game's
 * current title, so in the ordinary case the right entry has to come back
 * first and the player's whole job is one click. A search that returns the
 * right answer in ninth place has failed even though it found it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCatalogue, SEARCH_LIMIT } from '../src/services/catalogue-search.js';
import type { GameMetadata } from '../src/db/types.js';

function entry(over: Partial<GameMetadata>): GameMetadata {
  return {
    id: over.id ?? 'x', title: over.title ?? 'A Game', altTitle: over.altTitle ?? null,
    genre: null, publisher: over.publisher ?? null, developer: null,
    releaseDate: over.releaseDate ?? null, players: null, region: over.region ?? null,
    description: null, coverUrl: over.coverUrl ?? null, crc32: null, md5: null,
    source: over.source ?? 'catalogue', contributedBy: null, hasCover: false,
    createdAt: new Date(0), updatedAt: new Date(0)
  };
}

test('an exact title comes before a prefix, which comes before a mere mention', () => {
  const entries = [
    entry({ id: 'mention', title: 'Super Mario World 2: Yoshi\'s Island' }),
    entry({ id: 'exact', title: 'Super Mario World' }),
    entry({ id: 'prefix', title: 'Super Mario World Deluxe' })
  ];

  const ranked = rankCatalogue(entries, 'Super Mario World');

  assert.deepEqual(ranked.map(m => m.id), ['exact', 'prefix', 'mention']);
});

test('the filename a player actually has still finds the game', () => {
  // normalizeTitle strips the extension, the region tag and the leading "The",
  // which is what makes a raw filename a usable query.
  const entries = [entry({ id: 'sm', title: 'Super Metroid' })];

  assert.equal(rankCatalogue(entries, 'Super Metroid (USA).sfc')[0].id, 'sm');
});

test('a japanese alternate title matches too', () => {
  const entries = [entry({ id: 'act', title: 'ActRaiser', altTitle: 'アクトレイザー' })];

  assert.equal(rankCatalogue(entries, 'アクトレイザー')[0].id, 'act');
});

test('a query too short to mean anything returns nothing', () => {
  const entries = [entry({ id: 'a', title: 'A Game' })];

  // One letter would match most of the catalogue and rank it arbitrarily.
  assert.deepEqual(rankCatalogue(entries, 'a'), []);
  assert.deepEqual(rankCatalogue(entries, ''), []);
});

test('no match is an empty list, not a wrong guess', () => {
  const entries = [entry({ id: 'sm', title: 'Super Metroid' })];

  assert.deepEqual(rankCatalogue(entries, 'Pilotwings'), []);
});

test('the result set is capped', () => {
  const entries = Array.from({ length: 50 }, (_, i) => entry({ id: `g${i}`, title: `Contra ${i}` }));

  assert.equal(rankCatalogue(entries, 'Contra').length, SEARCH_LIMIT);
});

test('a match carries what the player needs to tell two entries apart', () => {
  const entries = [entry({
    id: 'sm', title: 'Super Metroid', region: 'NTSC', publisher: 'Nintendo',
    releaseDate: '1994-03-19', coverUrl: '/api/covers/sm?v=1', source: 'community'
  })];

  const [match] = rankCatalogue(entries, 'Super Metroid');

  assert.deepEqual(match, {
    id: 'sm', title: 'Super Metroid', altTitle: null, region: 'NTSC',
    publisher: 'Nintendo', releaseDate: '1994-03-19',
    coverUrl: '/api/covers/sm?v=1', source: 'community'
  });
});
```

- [ ] **Step 2: Lancer pour vérifier l'échec**

Run: `npm run test:backend`
Expected: FAIL — `Cannot find module '../src/services/catalogue-search.js'`.

- [ ] **Step 3: Écrire `services/catalogue-search.ts`**

```typescript
/**
 * Finding the catalogue entry a player means.
 *
 * Pure, and reading the catalogue from an argument rather than the database:
 * the caller passes the in-memory cache, so a search costs no query, and the
 * ranking can be tested for the thing that actually matters -- that the entry
 * the player means comes back first.
 */

import { normalizeTitle } from './metadata-loader.js';
import type { GameMetadata, MetadataSource } from '../db/types.js';

/** Enough to tell two dumps of the same game apart, and nothing more. */
export interface CatalogueMatch {
  id: string;
  title: string;
  altTitle: string | null;
  region: string | null;
  publisher: string | null;
  releaseDate: string | null;
  coverUrl: string | null;
  source: MetadataSource;
}

export const SEARCH_LIMIT = 20;

/** Below this, a query matches most of the catalogue and orders it arbitrarily. */
const MIN_QUERY = 2;

/** Lower is better; null means no match at all. */
function score(candidate: string, query: string): number | null {
  if (!candidate) return null;
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;
  if (candidate.includes(query)) return 2;
  return null;
}

function best(entry: GameMetadata, query: string): number | null {
  const scores = [
    score(normalizeTitle(entry.title), query),
    entry.altTitle ? score(normalizeTitle(entry.altTitle), query) : null
  ].filter((s): s is number => s !== null);
  return scores.length > 0 ? Math.min(...scores) : null;
}

function toMatch(entry: GameMetadata): CatalogueMatch {
  return {
    id: entry.id,
    title: entry.title,
    altTitle: entry.altTitle,
    region: entry.region,
    publisher: entry.publisher,
    releaseDate: entry.releaseDate,
    coverUrl: entry.coverUrl,
    source: entry.source
  };
}

export function rankCatalogue(entries: GameMetadata[], query: string): CatalogueMatch[] {
  const normalised = normalizeTitle(query);
  if (normalised.length < MIN_QUERY) return [];

  const scored: { entry: GameMetadata; rank: number }[] = [];
  for (const entry of entries) {
    const rank = best(entry, normalised);
    if (rank !== null) scored.push({ entry, rank });
  }

  // Alphabetical within a rank, so the order is stable rather than whatever
  // the table happened to return.
  scored.sort((a, b) => a.rank - b.rank || a.entry.title.localeCompare(b.entry.title));

  return scored.slice(0, SEARCH_LIMIT).map(s => toMatch(s.entry));
}
```

`normalizeTitle` gère déjà les extensions, les balises de région et le « The » initial — ne pas le réécrire ici.

- [ ] **Step 4: Écrire le routeur**

Créer `backend/src/api/metadata.ts` :

```typescript
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { cachedCatalogue } from '../services/metadata-loader.js';
import { rankCatalogue } from '../services/catalogue-search.js';

/**
 * The shared catalogue, as players search and extend it.
 *
 * Search costs no query: the catalogue is already in memory, held by
 * metadata-loader's cache, and every contribution invalidates it.
 */
export const metadataRouter = Router();

metadataRouter.use(requireAuth);

metadataRouter.get('/search', asyncHandler(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  res.json(rankCatalogue(cachedCatalogue(), q));
}));
```

Dans `backend/src/index.ts`, ajouter `import { metadataRouter } from './api/metadata.js';` sous les autres imports d'API (vers la ligne 18) et `app.use('/api/metadata', metadataRouter);` avec les autres montages (vers la ligne 219).

- [ ] **Step 5: Lancer les tests**

Run: `npm run test:backend`
Expected: PASS.

- [ ] **Step 6: Vérifier que le serveur démarre**

Run: `cd backend && npx tsc --noEmit`
Expected: aucune erreur.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/catalogue-search.ts backend/src/api/metadata.ts backend/src/index.ts backend/test/catalogue-search.test.ts
git commit -m "Let a player search the catalogue for the game they hold"
```

---

### Task 5: Identifier un jeu

**Files:**
- Create: `backend/src/api/entry-input.ts`
- Create: `backend/test/entry-input.test.ts`
- Modify: `backend/src/api/games.ts` (nouvelle route après `/:gameId/checksum`, vers la ligne 118)

**Interfaces:**
- Consumes: `findLinkByChecksum`, `linkChecksum` (Task 2), `findGameMetadataById`, `insertCommunityMetadata`, `CommunityEntryInput` (Task 2), `invalidateMetadataCache` (Task 1).
- Produces:
  - `sanitiseEntry(raw: unknown, fallbackTitle: string): CommunityEntryInput`
  - `MAX_FIELD = 200`, `MAX_DESCRIPTION = 2000`
  - route `POST /api/games/:gameId/identify`, réponse `{ metadataId: string }` ou `{ metadataId, metadata }`

- [ ] **Step 1: Écrire le test de validation**

Créer `backend/test/entry-input.test.ts` :

```typescript
/**
 * What a player typed, on its way to the database.
 *
 * Everything is optional by design, which means this function's job is to turn
 * an arbitrary JSON body into a row that cannot be malformed: no undefined
 * (better-sqlite3 throws on binding one), no empty strings pretending to be
 * values, and a title, because the column is NOT NULL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseEntry, MAX_FIELD, MAX_DESCRIPTION } from '../src/api/entry-input.js';

test('an empty body still yields a valid row, titled after the game', () => {
  const entry = sanitiseEntry({}, 'smw.sfc');

  assert.equal(entry.title, 'smw.sfc');
  assert.equal(entry.genre, null);
  assert.equal(entry.altTitle, null);
  assert.equal(entry.description, null);
});

test('what the player typed is kept, trimmed', () => {
  const entry = sanitiseEntry({ title: '  Super Mario World  ', genre: 'Platform' }, 'smw.sfc');

  assert.equal(entry.title, 'Super Mario World');
  assert.equal(entry.genre, 'Platform');
});

test('a field left blank is null, never an empty string', () => {
  // An empty string would show up as a present-but-blank genre in every UI
  // that tests truthiness on it.
  const entry = sanitiseEntry({ genre: '   ', title: '' }, 'smw.sfc');

  assert.equal(entry.genre, null);
  assert.equal(entry.title, 'smw.sfc', 'a blank title falls back like a missing one');
});

test('a value that is not a string is dropped rather than coerced', () => {
  const entry = sanitiseEntry({ genre: 42, players: ['1', '2'], region: null }, 'smw.sfc');

  assert.equal(entry.genre, null);
  assert.equal(entry.players, null);
  assert.equal(entry.region, null);
});

test('a non-object body is treated as an empty one', () => {
  assert.equal(sanitiseEntry(null, 'smw.sfc').title, 'smw.sfc');
  assert.equal(sanitiseEntry('nonsense', 'smw.sfc').title, 'smw.sfc');
});

test('fields are capped rather than refused', () => {
  const entry = sanitiseEntry(
    { title: 'T'.repeat(500), description: 'D'.repeat(5000) },
    'smw.sfc'
  );

  assert.equal(entry.title.length, MAX_FIELD);
  assert.equal(entry.description!.length, MAX_DESCRIPTION);
});

test('unknown keys do not travel', () => {
  const entry = sanitiseEntry({ title: 'Ok', source: 'catalogue', id: 'hijack' }, 'smw.sfc');

  assert.equal(Object.hasOwn(entry, 'source'), false);
  assert.equal(Object.hasOwn(entry, 'id'), false);
});
```

- [ ] **Step 2: Lancer pour vérifier l'échec**

Run: `npm run test:backend`
Expected: FAIL — `Cannot find module '../src/api/entry-input.js'`.

- [ ] **Step 3: Écrire `api/entry-input.ts`**

```typescript
import type { CommunityEntryInput } from '../db/game-metadata.js';

/** Long enough for any real title or publisher, short enough to bound a row. */
export const MAX_FIELD = 200;

/** A description is prose; the rest are labels. */
export const MAX_DESCRIPTION = 2000;

/**
 * Turns whatever arrived in the body into a row that cannot be malformed.
 *
 * Every field being optional is the feature -- a player fills in what they
 * know -- so this normalises rather than refuses: a blank becomes null (an
 * empty string would read as a present-but-blank value in every UI that tests
 * truthiness), a non-string is dropped rather than coerced, and the keys are
 * enumerated so nothing else in the body can reach a column. The title falls
 * back to the game's current name, because the column is NOT NULL and "all
 * optional" must not mean "a row with no title".
 */
export function sanitiseEntry(raw: unknown, fallbackTitle: string): CommunityEntryInput {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const field = (key: string, max = MAX_FIELD): string | null => {
    const value = body[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed.slice(0, max);
  };

  return {
    title: field('title') ?? fallbackTitle.slice(0, MAX_FIELD),
    altTitle: field('altTitle'),
    genre: field('genre'),
    publisher: field('publisher'),
    developer: field('developer'),
    releaseDate: field('releaseDate'),
    players: field('players'),
    region: field('region'),
    description: field('description', MAX_DESCRIPTION)
  };
}
```

- [ ] **Step 4: Écrire la route**

Dans `backend/src/api/games.ts`, étendre les imports :

```typescript
import { findGameMetadataById, insertCommunityMetadata } from '../db/game-metadata.js';
import { findLinkByChecksum, linkChecksum } from '../db/metadata-links.js';
import { invalidateMetadataCache } from '../services/metadata-loader.js';
import { sanitiseEntry } from './entry-input.js';
```

Ajouter après la route `/:gameId/checksum` :

```typescript
/**
 * Says which game a ROM is, for everyone.
 *
 * Either the player points at an entry that already exists, or they write one.
 * Both end in the same place: a row in "GameMetadataChecksum" claiming this
 * dump's CRC32. That row is a fact about the world rather than about this
 * player, which is why it reaches every other owner of the same dump -- and
 * why creating an entry without linking it is not offered: the entry exists
 * *because* a ROM was looking for it.
 */
gamesRouter.post('/:gameId/identify', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const { metadataId, entry } = req.body ?? {};

  const db = getDb();
  const game = findGameById(db, req.params.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.userId !== user.id) return res.status(403).json({ error: 'Not authorized' });
  if (!game.crc32) {
    return res.status(400).json({ error: 'Link a ROM to this game before identifying it' });
  }

  const claimed = findLinkByChecksum(db, game.crc32);
  if (claimed) {
    if (claimed.metadataId === metadataId) {
      // Idempotent rather than a conflict: pressing the button twice, or two
      // tabs agreeing, is not an error.
      return res.json({ metadataId: claimed.metadataId });
    }
    // Not really a failure. If this dump is claimed, its metadata already
    // applies everywhere - so the caller is looking at a stale library, and the
    // useful answer is what it actually is.
    return res.status(409).json({
      error: 'This ROM has already been identified',
      metadata: findGameMetadataById(db, claimed.metadataId)
    });
  }

  if (typeof metadataId === 'string') {
    if (!findGameMetadataById(db, metadataId)) {
      return res.status(404).json({ error: 'No such catalogue entry' });
    }
    linkChecksum(db, { crc32: game.crc32, metadataId, contributedBy: user.id });
    logger.info({ crc32: game.crc32, metadataId, by: user.id }, 'ROM linked to a catalogue entry');
    return res.json({ metadataId });
  }

  if (entry !== undefined) {
    const checksum = game.crc32;
    const created = db.transaction(() => {
      const meta = insertCommunityMetadata(db, sanitiseEntry(entry, game.title), user.id);
      linkChecksum(db, { crc32: checksum, metadataId: meta.id, contributedBy: user.id });
      return meta;
    })();
    // The cache feeds the title matcher and the search: without this the entry
    // would not be findable until the container restarted.
    invalidateMetadataCache();
    logger.info({ crc32: checksum, metadataId: created.id, by: user.id }, 'Catalogue entry contributed');
    return res.json({ metadataId: created.id, metadata: created });
  }

  return res.status(400).json({ error: 'Either metadataId or entry is required' });
}));
```

- [ ] **Step 5: Lancer les tests et le typecheck**

Run: `npm run test:backend && cd backend && npx tsc --noEmit`
Expected: PASS et aucune erreur de type.

- [ ] **Step 6: Commit**

```bash
git add backend/src/api/entry-input.ts backend/src/api/games.ts backend/test/entry-input.test.ts
git commit -m "Let a player say which game a ROM is"
```

---

### Task 6: La jaquette

**Files:**
- Create: `backend/src/utils/image-kind.ts`
- Create: `backend/src/api/covers.ts`
- Create: `backend/test/image-kind.test.ts`
- Modify: `backend/src/api/metadata.ts` (route `PUT /:metadataId/cover`)
- Modify: `backend/src/middleware/error.ts`
- Modify: `backend/src/index.ts` (montage de `/api/covers`)

**Interfaces:**
- Consumes: `findGameMetadataById`, `setCover`, `findCover` (Task 2), `metadataRouter` (Task 4).
- Produces:
  - `type ImageKind = 'image/png' | 'image/jpeg' | 'image/webp'`
  - `imageKindOf(bytes: Buffer): ImageKind | null`
  - `COVER_LIMIT = '400kb'`
  - routes `PUT /api/metadata/:metadataId/cover` → `{ coverUrl: string }`, `GET /api/covers/:metadataId`

- [ ] **Step 1: Écrire le test du renifleur**

Créer `backend/test/image-kind.test.ts` :

```typescript
/**
 * What an uploaded file actually is.
 *
 * The Content-Type is a claim made by whoever is uploading, and these bytes go
 * back out of the server to other players' browsers with a Content-Type of our
 * own. So the format is read from the file's own header, and a mismatch is
 * refused rather than trusted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageKindOf } from '../src/utils/image-kind.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP', 'latin1')
]);

test('the three formats are recognised by their header', () => {
  assert.equal(imageKindOf(PNG), 'image/png');
  assert.equal(imageKindOf(JPEG), 'image/jpeg');
  assert.equal(imageKindOf(WEBP), 'image/webp');
});

test('anything else is refused, whatever it claims to be', () => {
  assert.equal(imageKindOf(Buffer.from('<svg onload="alert(1)">', 'latin1')), null);
  assert.equal(imageKindOf(Buffer.from('GIF89a', 'latin1')), null);
  assert.equal(imageKindOf(Buffer.alloc(0)), null);
  assert.equal(imageKindOf(Buffer.from([0x89, 0x50])), null, 'a truncated header is not a format');
});

test('a RIFF container that is not WebP is not a WebP', () => {
  const wav = Buffer.concat([
    Buffer.from('RIFF', 'latin1'), Buffer.from([1, 2, 3, 4]), Buffer.from('WAVE', 'latin1')
  ]);
  assert.equal(imageKindOf(wav), null);
});
```

- [ ] **Step 2: Lancer pour vérifier l'échec**

Run: `npm run test:backend`
Expected: FAIL — `Cannot find module '../src/utils/image-kind.js'`.

- [ ] **Step 3: Écrire `utils/image-kind.ts`**

```typescript
/**
 * The format a file actually is, read from its own first bytes.
 *
 * A declared Content-Type is a claim made by the uploader, and these bytes
 * come back out of the server with a Content-Type we set -- so believing the
 * claim would let one player choose the type another player's browser applies
 * to the response.
 */

export type ImageKind = 'image/png' | 'image/jpeg' | 'image/webp';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function imageKindOf(bytes: Buffer): ImageKind | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP is a RIFF container, so both markers have to be checked: the first
  // four bytes alone would also accept a WAV file.
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
```

- [ ] **Step 4: Ajouter la route d'envoi**

Dans `backend/src/api/metadata.ts`, étendre les imports :

```typescript
import express from 'express';
import { User } from '../types/index.js';
import { getDb } from '../db/sqlite.js';
import { findGameMetadataById, setCover } from '../db/game-metadata.js';
import { invalidateMetadataCache } from '../services/metadata-loader.js';
import { imageKindOf } from '../utils/image-kind.js';
```

Ajouter après la route de recherche :

```typescript
/**
 * A cover, sized on the client and sent as bytes.
 *
 * Raw rather than a data URI inside JSON, for three reasons. The global
 * `express.json()` is mounted before every router (index.ts:124), so a 400 KB
 * data URI would be rejected with a 413 before reaching this handler; a raw
 * parser scoped to these three content types is skipped by that global one,
 * which only claims `application/json`; and base64 would cost a third of the
 * payload for nothing.
 */
export const COVER_LIMIT = '400kb';

metadataRouter.put(
  '/:metadataId/cover',
  express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: COVER_LIMIT }),
  asyncHandler(async (req, res) => {
    const user = req.user as User;
    const db = getDb();

    const entry = findGameMetadataById(db, req.params.metadataId);
    if (!entry) return res.status(404).json({ error: 'No such catalogue entry' });
    if (entry.contributedBy !== user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // A Content-Type outside the three above is never parsed, so the body is
    // whatever the global parsers left behind rather than a Buffer.
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return res.status(415).json({ error: 'A PNG, JPEG or WebP image is required' });
    }

    const kind = imageKindOf(bytes);
    if (!kind) {
      return res.status(415).json({ error: 'That file is not a PNG, JPEG or WebP image' });
    }

    const coverUrl = setCover(db, entry.id, bytes, kind);
    invalidateMetadataCache();
    res.json({ coverUrl });
  })
);
```

- [ ] **Step 5: Écrire la route de service**

Créer `backend/src/api/covers.ts` :

```typescript
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { getDb } from '../db/sqlite.js';
import { findCover } from '../db/game-metadata.js';

/**
 * Cover images, straight out of the database.
 *
 * Behind requireAuth, unlike avatars: this is content one player uploaded and
 * another downloads, and a same-origin <img> sends the session cookie anyway,
 * so the check costs nothing.
 *
 * Cached hard because the URL is versioned -- setCover appends the write's
 * timestamp -- so a replaced cover is a different URL rather than a stale hit.
 */
export const coversRouter = Router();

coversRouter.use(requireAuth);

coversRouter.get('/:metadataId', asyncHandler(async (req, res) => {
  const cover = findCover(getDb(), req.params.metadataId);
  if (!cover) return res.status(404).json({ error: 'Cover not found' });

  res.setHeader('Content-Type', cover.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(cover.bytes);
}));
```

Dans `backend/src/index.ts`, ajouter `import { coversRouter } from './api/covers.js';` et `app.use('/api/covers', coversRouter);`.

- [ ] **Step 6: Corriger le gestionnaire d'erreurs**

Dans `backend/src/middleware/error.ts`, insérer avant le log et le `res.status(500)` :

```typescript
/**
 * Body-parser rejections that are the client's fault, not ours.
 *
 * These arrive with their own status and a `type` naming what went wrong.
 * Answering 500 to all of them told a player "internal server error" for an
 * image that was merely too large -- so they retried it unchanged.
 */
const BODY_PARSER_MESSAGES: Record<string, string> = {
  'entity.too.large': 'That file is too large',
  'entity.parse.failed': 'Malformed request body',
  'entity.verify.failed': 'Malformed request body',
  'encoding.unsupported': 'Unsupported content encoding'
};
```

Puis, au début du corps de `errorHandler`, avant le `logger.error` :

```typescript
  const type = (err as { type?: string } | null)?.type;
  const status = (err as { status?: number } | null)?.status;
  if (!res.headersSent && type && BODY_PARSER_MESSAGES[type] && typeof status === 'number') {
    logger.warn({ type, status, path: req.path }, 'Rejected a malformed or oversized request body');
    return res.status(status).json({ error: BODY_PARSER_MESSAGES[type] });
  }
```

- [ ] **Step 7: Lancer les tests et le typecheck**

Run: `npm run test:backend && cd backend && npx tsc --noEmit`
Expected: PASS, aucune erreur de type.

- [ ] **Step 8: Commit**

```bash
git add backend/src/utils/image-kind.ts backend/src/api/covers.ts backend/src/api/metadata.ts backend/src/middleware/error.ts backend/src/index.ts backend/test/image-kind.test.ts
git commit -m "Take a cover from a player, and stop calling a big file a server fault"
```

---

### Task 7: Redimensionner la jaquette côté navigateur

**Files:**
- Create: `frontend/src/lib/games/cover.ts`
- Create: `core/test/cover.test.ts`
- Modify: `frontend/src/lib/saves/thumbnail.ts` (extraire `scaledSize`)
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: rien du backend.
- Produces:
  - depuis `saves/thumbnail.js` : `scaledSize(srcWidth, srcHeight, maxWidth): ThumbnailSize`
  - depuis `games/cover.js` : `COVER_MAX_WIDTH = 512`, `MAX_COVER_BYTES = 400 * 1024`, `coverSize(w, h)`, `encodeCover(file: File): Promise<{ bytes: Uint8Array; mime: string }>`

- [ ] **Step 1: Écrire le test**

Créer `core/test/cover.test.ts` :

```typescript
/**
 * Cover images, on their way from a file picker to the database.
 *
 * The server stores these as BLOBs and caps them at 400 KB, so the shrinking
 * happens here -- and it is the same trap as save thumbnails:
 * canvas.toDataURL('image/webp') does NOT throw on a browser that cannot
 * encode WebP, it silently returns a PNG many times larger. Reading the format
 * back out of the result is the only way to notice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { COVER_MAX_WIDTH, MAX_COVER_BYTES, coverSize } from '../../frontend/src/lib/games/cover.js';
import { imageFormatOf } from '../../frontend/src/lib/saves/thumbnail.js';

test('a large scan is brought down to the cover width, keeping its shape', () => {
  const { width, height } = coverSize(1400, 1000);

  assert.equal(width, COVER_MAX_WIDTH);
  assert.equal(height, 366, '1000 * 512/1400, rounded');
});

test('an image already smaller than the target is left alone', () => {
  // Upscaling a cover buys nothing and costs bytes.
  const { width, height } = coverSize(300, 200);

  assert.equal(width, 300);
  assert.equal(height, 200);
});

test('a degenerate source still yields at least one pixel', () => {
  // A zero-sized canvas throws, which would turn a broken file into a crash.
  const { width, height } = coverSize(0, 0);

  assert.ok(width >= 1);
  assert.ok(height >= 1);
});

test('the byte cap matches the one the server enforces', () => {
  // If these drift, the player gets a 413 from a picture the UI accepted.
  assert.equal(MAX_COVER_BYTES, 400 * 1024);
});

test('the format is read from the result, not assumed from the request', () => {
  assert.equal(imageFormatOf('data:image/png;base64,AAAA'), 'png');
  assert.equal(imageFormatOf('data:image/webp;base64,AAAA'), 'webp');
});
```

- [ ] **Step 2: Enregistrer le fichier de test et le lancer**

Dans `package.json`, ajouter `core/test/cover.test.ts` à la fin de la liste du script `test:ui` (elle énumère ses fichiers un par un).

Run: `npm run test:ui`
Expected: FAIL — `Cannot find module '.../frontend/src/lib/games/cover.js'`.

- [ ] **Step 3: Extraire `scaledSize`**

Dans `frontend/src/lib/saves/thumbnail.ts`, remplacer `thumbnailSize` par :

```typescript
/**
 * The size to draw at: the target width, keeping the source's shape.
 *
 * A source already narrower than the target is left alone - upscaling buys
 * nothing and costs bytes. A degenerate source (a capture taken before the
 * first frame was drawn) still yields at least one pixel, because a zero-sized
 * canvas throws.
 */
export function scaledSize(srcWidth: number, srcHeight: number, maxWidth: number): ThumbnailSize {
	const width = Math.max(1, Math.min(maxWidth, Math.round(srcWidth) || 1));
	const ratio = srcWidth > 0 ? width / srcWidth : 1;
	const height = Math.max(1, Math.round((srcHeight || 1) * ratio));
	return { width, height };
}

export function thumbnailSize(srcWidth: number, srcHeight: number): ThumbnailSize {
	return scaledSize(srcWidth, srcHeight, THUMBNAIL_WIDTH);
}
```

Les tests existants de `core/test/thumbnail.test.ts` doivent continuer de passer sans modification.

- [ ] **Step 4: Écrire `games/cover.ts`**

```typescript
/**
 * A cover image, on its way from a file picker to the shared catalogue.
 *
 * The server keeps these as BLOBs beside the rest of a catalogue row and caps
 * a request at 400 KB, so the shrinking happens here rather than being
 * rejected there. The awkward part is inherited from save thumbnails:
 * `canvas.toDataURL('image/webp')` does NOT throw on a browser that cannot
 * encode WebP - it silently returns a PNG many times larger - so the format is
 * read back out of the result and JPEG is tried before giving up.
 */

import { imageFormatOf, scaledSize, type ImageFormat, type ThumbnailSize } from '../saves/thumbnail.js';

/** Wide enough to read a box front, small enough to keep the row cheap. */
export const COVER_MAX_WIDTH = 512;

/** The same ceiling the server enforces; if these drift, the UI accepts what the API refuses. */
export const MAX_COVER_BYTES = 400 * 1024;

const QUALITY = 0.82;

const MIME: Record<ImageFormat, string> = {
	webp: 'image/webp',
	jpeg: 'image/jpeg',
	png: 'image/png'
};

export function coverSize(srcWidth: number, srcHeight: number): ThumbnailSize {
	return scaledSize(srcWidth, srcHeight, COVER_MAX_WIDTH);
}

/**
 * Reads a picked file and returns the bytes to send.
 *
 * Browser-only: it needs a real canvas. Throws when the file is not an image
 * the browser can decode, or when even the JPEG attempt stays above the cap -
 * a caller cannot do anything useful with a picture the server will refuse.
 */
export async function encodeCover(file: File): Promise<{ bytes: Uint8Array; mime: string }> {
	const bitmap = await createImageBitmap(file);
	const { width, height } = coverSize(bitmap.width, bitmap.height);

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('This browser cannot resize the image');
	context.drawImage(bitmap, 0, 0, width, height);
	bitmap.close();

	for (const requested of ['image/webp', 'image/jpeg'] as const) {
		const uri = canvas.toDataURL(requested, QUALITY);
		const format = imageFormatOf(uri);
		if (!format) continue;
		const bytes = decodeDataUri(uri);
		// A PNG here means the browser ignored the request. It is accepted only
		// if it happens to fit, rather than looping forever on the same answer.
		if (bytes.byteLength <= MAX_COVER_BYTES) return { bytes, mime: MIME[format] };
	}

	throw new Error('That image is too large even once resized');
}

function decodeDataUri(uri: string): Uint8Array {
	const base64 = uri.slice(uri.indexOf(',') + 1);
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
```

- [ ] **Step 5: Lancer les tests**

Run: `npm run test:ui`
Expected: PASS, `thumbnail.test.ts` compris.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/games/cover.ts frontend/src/lib/saves/thumbnail.ts core/test/cover.test.ts package.json
git commit -m "Shrink a cover before it leaves the browser"
```

---

### Task 8: L'écran d'identification

**Files:**
- Create: `frontend/src/lib/components/IdentifyGame.svelte`
- Modify: `frontend/src/lib/i18n/translations.ts` (dictionnaires `en` et `fr`)
- Modify: `frontend/src/lib/stores/games.ts` (type `Game`)
- Modify: `frontend/src/lib/components/GameCard.svelte:46-51,78-91`
- Modify: `frontend/src/lib/components/GameDetailsModal.svelte` (bas de la fiche)
- Modify: `frontend/src/routes/+page.svelte:19,300-315`

**Interfaces:**
- Consumes: `GET /api/metadata/search` (Task 4), `POST /api/games/:gameId/identify` (Task 5), `PUT /api/metadata/:id/cover` (Task 6), `encodeCover` (Task 7), `needsIdentification` dans la réponse de `/api/games` (Task 3).
- Produces: composant `IdentifyGame` avec les props `gameId: string`, `title: string`, et les événements `close` et `identified`.

- [ ] **Step 1: Étendre le type du store**

Dans `frontend/src/lib/stores/games.ts`, ajouter à l'interface `Game` :

```typescript
  /** The catalogue entry this game's dump is linked to, if anyone has said. */
  metadataId?: string | null;
  /** Whether nothing at all is known about this game, so the player can say. */
  needsIdentification?: boolean;
```

- [ ] **Step 2: Ajouter les clés i18n**

Dans `frontend/src/lib/i18n/translations.ts`, dans le dictionnaire `en`, à côté de `needsRom` (ligne 57) :

```typescript
    needsIdentification: 'To identify',
    identifyGame: 'Identify this game',
    completeEntry: 'Complete this entry',
    identifyExplain: 'Nothing here recognises this ROM. Say which game it is and every player who owns the same copy gets it too.',
    identifySearchPlaceholder: 'Search the catalogue',
    identifyNoResults: 'Nothing matches that.',
    identifyCreate: 'None of these — create an entry',
    identifyBackToSearch: 'Back to the search',
    identifyCreateTitle: 'Describe the game',
    identifyCreateExplain: 'Every field is optional. Fill in what you know.',
    identifyCreateSubmit: 'Create and link',
    identifyLinked: 'Thank you — everyone gets this now.',
    identifyAlreadyClaimed: 'This ROM has just been identified as',
    identifyCoverFailed: 'The entry was created, but the image did not upload.',
    identifyRetryCover: 'Try the image again',
    gameTitle: 'Title',
    gameDescription: 'Description',
    coverImage: 'Cover image',
    chooseAnImage: 'Choose an image',
```

Et dans le dictionnaire `fr`, à côté de `needsRom` (ligne 343) :

```typescript
    needsIdentification: 'À identifier',
    identifyGame: 'Identifier ce jeu',
    completeEntry: 'Compléter la fiche',
    identifyExplain: 'Rien ici ne reconnaît cette ROM. Dis de quel jeu il s\'agit, et tous les joueurs qui ont la même copie en profiteront.',
    identifySearchPlaceholder: 'Chercher dans le catalogue',
    identifyNoResults: 'Aucun résultat.',
    identifyCreate: 'Aucun ne correspond — créer une fiche',
    identifyBackToSearch: 'Revenir à la recherche',
    identifyCreateTitle: 'Décris le jeu',
    identifyCreateExplain: 'Tous les champs sont optionnels. Renseigne ce que tu sais.',
    identifyCreateSubmit: 'Créer et lier',
    identifyLinked: 'Merci — tout le monde en profite maintenant.',
    identifyAlreadyClaimed: 'Cette ROM vient d\'être identifiée comme',
    identifyCoverFailed: 'La fiche est créée, mais l\'image n\'a pas été envoyée.',
    identifyRetryCover: 'Réessayer l\'image',
    gameTitle: 'Titre',
    gameDescription: 'Description',
    coverImage: 'Jaquette',
    chooseAnImage: 'Choisir une image',
```

- [ ] **Step 3: Écrire `IdentifyGame.svelte`**

```svelte
<script lang="ts">
  /**
   * Saying which game a ROM is.
   *
   * Two states, and the order matters: searching first, because the answer is
   * usually already in the catalogue and the search field is seeded with the
   * game's current title - so the ordinary case is one click on a result that
   * is already at the top. Writing an entry is the fallback, reached from a
   * link rather than offered as an equal choice, since a duplicate entry is
   * worse than a link to an existing one.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { encodeCover } from '$lib/games/cover';
  import { createLogger } from '$lib/utils/logger';

  const logger = createLogger('IdentifyGame');
  const dispatch = createEventDispatcher<{ close: void; identified: string }>();

  export let gameId: string;
  export let title = '';

  interface Match {
    id: string;
    title: string;
    altTitle: string | null;
    region: string | null;
    publisher: string | null;
    releaseDate: string | null;
    coverUrl: string | null;
  }

  let mode: 'search' | 'create' = 'search';
  let query = title;
  let results: Match[] = [];
  let searching = false;
  let busy = false;
  let error = '';
  /** Set when the entry landed but its image did not, so only the image is retried. */
  let coverPendingFor: string | null = null;

  let form = {
    title, altTitle: '', genre: '', publisher: '', developer: '',
    releaseDate: '', players: '', region: '', description: ''
  };
  let coverFile: File | null = null;
  let coverPreview = '';

  let searchTimer: ReturnType<typeof setTimeout>;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !busy) dispatch('close');
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    search();
    return () => window.removeEventListener('keydown', handleKeydown);
  });

  async function search() {
    if (query.trim().length < 2) {
      results = [];
      return;
    }
    searching = true;
    try {
      const res = await fetch(`/api/metadata/search?q=${encodeURIComponent(query)}`, {
        credentials: 'include'
      });
      results = res.ok ? await res.json() : [];
    } catch (err) {
      logger.warn('The catalogue search failed', err);
      results = [];
    } finally {
      searching = false;
    }
  }

  function onQueryInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(search, 200);
  }

  /** Posts the identification and turns the API's answers into something readable. */
  async function identify(body: Record<string, unknown>): Promise<string | null> {
    const res = await fetch(`/api/games/${gameId}/identify`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await res.json().catch(() => ({}));

    if (res.status === 409) {
      // Not a failure: if this dump is claimed, its metadata already applies
      // everywhere, so this library is simply out of date.
      error = `${t($language, 'identifyAlreadyClaimed')} ${payload.metadata?.title ?? '?'}`;
      dispatch('identified', payload.metadata?.id ?? '');
      return null;
    }
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    return payload.metadataId as string;
  }

  async function linkTo(match: Match) {
    busy = true;
    error = '';
    try {
      const metadataId = await identify({ metadataId: match.id });
      if (metadataId) dispatch('identified', metadataId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error('Could not link the game', err);
    } finally {
      busy = false;
    }
  }

  async function onCoverChosen(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0] ?? null;
    coverFile = file;
    coverPreview = file ? URL.createObjectURL(file) : '';
  }

  /**
   * Sends the image on its own.
   *
   * Separate from the entry deliberately: the bytes go raw so they skip the
   * global JSON parser's limit, which means two requests - and the entry is
   * created first, so a failed upload leaves a valid, linked entry rather than
   * losing what the player typed.
   */
  async function uploadCover(metadataId: string): Promise<void> {
    if (!coverFile) return;
    const { bytes, mime } = await encodeCover(coverFile);
    const res = await fetch(`/api/metadata/${metadataId}/cover`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': mime },
      body: bytes
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${res.status}`);
    }
  }

  async function createEntry() {
    busy = true;
    error = '';
    try {
      const metadataId = coverPendingFor ?? (await identify({ entry: form }));
      if (!metadataId) return;
      try {
        await uploadCover(metadataId);
      } catch (err) {
        // The entry exists and is linked; only the picture is missing.
        coverPendingFor = metadataId;
        error = `${t($language, 'identifyCoverFailed')} ${err instanceof Error ? err.message : ''}`;
        return;
      }
      dispatch('identified', metadataId);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error('Could not create the entry', err);
    } finally {
      busy = false;
    }
  }

  function year(date: string | null): string {
    return date ? date.slice(0, 4) : '';
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="backdrop" role="presentation" on:click={() => !busy && dispatch('close')}>
  <div class="modal" role="dialog" aria-modal="true" on:click|stopPropagation>
    {#if mode === 'search'}
      <h2>{t($language, 'identifyGame')}</h2>
      <p class="explain">{t($language, 'identifyExplain')}</p>

      <input
        class="search"
        type="search"
        bind:value={query}
        on:input={onQueryInput}
        placeholder={t($language, 'identifySearchPlaceholder')}
        disabled={busy}
      />

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <ul class="results">
        {#each results as match (match.id)}
          <li>
            <button class="result" on:click={() => linkTo(match)} disabled={busy}>
              {#if match.coverUrl}
                <img src={match.coverUrl} alt="" class="thumb" />
              {:else}
                <span class="thumb placeholder">🎮</span>
              {/if}
              <span class="result-text">
                <strong>{match.title}</strong>
                <small>
                  {[match.publisher, match.region, year(match.releaseDate)]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </span>
            </button>
          </li>
        {/each}
      </ul>

      {#if !searching && results.length === 0 && query.trim().length >= 2}
        <p class="explain">{t($language, 'identifyNoResults')}</p>
      {/if}

      <div class="actions">
        <button class="secondary" on:click={() => dispatch('close')} disabled={busy}>
          {t($language, 'cancel')}
        </button>
        <button class="link" on:click={() => (mode = 'create')} disabled={busy}>
          {t($language, 'identifyCreate')}
        </button>
      </div>
    {:else}
      <h2>{t($language, 'identifyCreateTitle')}</h2>
      <p class="explain">{t($language, 'identifyCreateExplain')}</p>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <div class="fields">
        <label>{t($language, 'gameTitle')}<input bind:value={form.title} disabled={busy} /></label>
        <label>{t($language, 'genre')}<input bind:value={form.genre} disabled={busy} /></label>
        <label>{t($language, 'publisher')}<input bind:value={form.publisher} disabled={busy} /></label>
        <label>{t($language, 'developer')}<input bind:value={form.developer} disabled={busy} /></label>
        <label>{t($language, 'releaseDate')}<input bind:value={form.releaseDate} disabled={busy} placeholder="1994-03-19" /></label>
        <label>{t($language, 'players')}<input bind:value={form.players} disabled={busy} /></label>
        <label>{t($language, 'region')}<input bind:value={form.region} disabled={busy} /></label>
      </div>

      <label class="wide">
        {t($language, 'gameDescription')}
        <textarea bind:value={form.description} rows="3" disabled={busy}></textarea>
      </label>

      <label class="wide">
        {t($language, 'coverImage')}
        <input type="file" accept="image/png,image/jpeg,image/webp" on:change={onCoverChosen} disabled={busy} />
      </label>
      {#if coverPreview}
        <img src={coverPreview} alt="" class="preview" />
      {/if}

      <div class="actions">
        <button class="secondary" on:click={() => (mode = 'search')} disabled={busy}>
          {t($language, 'identifyBackToSearch')}
        </button>
        <button class="primary" on:click={createEntry} disabled={busy}>
          {busy
            ? t($language, 'loading')
            : coverPendingFor
              ? t($language, 'identifyRetryCover')
              : t($language, 'identifyCreateSubmit')}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  /* The same modal look LinkRom.svelte uses, repeated rather than shared
     because Svelte scopes styles to the component that owns the markup. */
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }

  .modal {
    background: #1b1b26;
    border: 1px solid #2c2c3c;
    border-radius: 12px;
    padding: 1.5rem;
    width: 100%;
    max-width: 520px;
    max-height: 85vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  h2 {
    margin: 0;
    font-size: 1.15rem;
    color: #fff;
  }

  .explain {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.5;
    color: #8b8ba3;
  }

  .error {
    margin: 0;
    color: #ff8f8f;
    font-size: 0.85rem;
  }

  .search,
  input,
  textarea {
    background: #12121a;
    border: 1px solid #2c2c3c;
    border-radius: 6px;
    padding: 0.45rem 0.6rem;
    color: #eee;
    font-size: 0.9rem;
    width: 100%;
  }

  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: 40vh;
    overflow-y: auto;
  }

  .result {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    text-align: left;
    background: #12121a;
    border: 1px solid #2c2c3c;
    padding: 0.45rem;
    color: #eee;
  }

  .result:hover:not(:disabled) {
    border-color: #667eea;
  }

  .thumb {
    width: 40px;
    height: 30px;
    object-fit: cover;
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1f1f2b;
    flex: 0 0 auto;
  }

  .result-text {
    display: flex;
    flex-direction: column;
  }

  .result-text small {
    color: #8b8ba3;
    font-size: 0.75rem;
  }

  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  label,
  .wide {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.75rem;
    color: #9aa0b4;
  }

  .preview {
    max-width: 160px;
    border-radius: 6px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  button {
    border-radius: 6px;
    padding: 0.5rem 1.1rem;
    font-size: 0.9rem;
    cursor: pointer;
    border: 1px solid transparent;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .secondary {
    background: transparent;
    border-color: #3d3d52;
    color: #b7b7cc;
  }

  .primary {
    background: #667eea;
    color: #fff;
  }

  .link {
    background: transparent;
    color: #8fa2ff;
    padding-left: 0;
    padding-right: 0;
  }
</style>
```

- [ ] **Step 4: Ajouter le badge sur la carte**

Dans `frontend/src/lib/components/GameCard.svelte`, après le bloc `{#if !game.crc32}` (qui se ferme ligne 51) :

```svelte
    {#if game.needsIdentification && game.crc32}
      <!-- Only when a checksum exists: without one there is nothing to
           identify yet, and "ROM to locate" is the truer thing to say. -->
      <div class="needs-identification" title={t($language, 'identifyExplain')}>
        {t($language, 'needsIdentification')}
      </div>
    {/if}
```

Et dans le bloc `<style>`, à côté de `.needs-rom` :

```css
  .needs-identification {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 2;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    background: rgba(102, 126, 234, 0.92);
    color: #fff;
    font-size: 0.68rem;
    font-weight: 600;
  }
```

- [ ] **Step 5: Ajouter le bouton sur la fiche**

Dans `frontend/src/lib/components/GameDetailsModal.svelte`, après le bloc `.filename-section` et avant la fermeture de `details-section` :

```svelte
        {#if game.crc32}
          <button class="identify" on:click={() => dispatch('identify')}>
            {game.needsIdentification
              ? t($language, 'identifyGame')
              : t($language, 'completeEntry')}
          </button>
        {/if}
```

Et dans son `<style>` :

```css
  .identify {
    margin-top: 1rem;
    align-self: flex-start;
    background: transparent;
    border: 1px solid #3d3d52;
    color: #b7b7cc;
    border-radius: 6px;
    padding: 0.45rem 1rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .identify:hover {
    border-color: #667eea;
    color: #fff;
  }
```

- [ ] **Step 6: Câbler la page**

Dans `frontend/src/routes/+page.svelte` :

Ajouter l'import sous celui de `LinkRom` (ligne 12) : `import IdentifyGame from '$lib/components/IdentifyGame.svelte';`

Ajouter la variable d'état à côté de `selectedGame` (ligne 19) : `let gameToIdentify: Game | null = null;`

Sur `GameDetailsModal` (ligne 310), ajouter le gestionnaire :

```svelte
      on:identify={() => { gameToIdentify = selectedGame; selectedGame = null; }}
```

Et après le bloc `{#if selectedGame}` :

```svelte
  {#if gameToIdentify}
    <IdentifyGame
      gameId={gameToIdentify.id}
      title={gameToIdentify.title}
      on:close={() => (gameToIdentify = null)}
      on:identified={() => { gameToIdentify = null; loadGames(); }}
    />
  {/if}
```

- [ ] **Step 7: Vérifier la compilation et l'aspect**

Run: `npm run test:ui`
Expected: PASS.

Puis, l'application tournant (`docker compose up -d`), ouvrir la bibliothèque et vérifier à la main : un jeu sans métadonnée porte le badge bleu ; la fiche ouvre la modale ; la recherche renvoie des résultats ; un clic sur un résultat fait disparaître le badge et remplit la carte.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/components/IdentifyGame.svelte frontend/src/lib/components/GameCard.svelte frontend/src/lib/components/GameDetailsModal.svelte frontend/src/lib/i18n/translations.ts frontend/src/lib/stores/games.ts frontend/src/routes/+page.svelte
git commit -m "Let a player name the game in front of them, in one click"
```

---

### Task 9: La preuve que tout le monde en profite

**Files:**
- Create: `e2e/identify-game.spec.ts`

**Interfaces:**
- Consumes: toutes les routes des tâches 4 à 6, et `loginDev` / `apiFetch` de `e2e/helpers.ts`.
- Produces: rien.

- [ ] **Step 1: Écrire le test**

Créer `e2e/identify-game.spec.ts` :

```typescript
/**
 * A contribution to the shared catalogue.
 *
 * The assertion that matters here is the last one, and no unit test can carry
 * it: a *second* account, which did nothing, sees the title the first account
 * posted. That is the whole reason the link lives in its own table and is
 * resolved at read time instead of being copied into each player's row.
 */

import { test, expect } from '@playwright/test';
import { loginDev, apiFetch } from './helpers';

/** A CRC32 no catalogue entry could match, so the game arrives unidentified. */
const CRC = 'A1B2C3D4';

async function addGame(cookie: string, filename: string) {
  const res = await apiFetch(cookie, '/api/games', {
    method: 'POST',
    body: JSON.stringify({ checksum: CRC, filename })
  });
  expect(res.ok).toBeTruthy();
  return res.json();
}

async function libraryEntry(cookie: string, gameId: string) {
  const games = await (await apiFetch(cookie, '/api/games')).json();
  return games.find((g: { id: string }) => g.id === gameId);
}

test.describe('completing the games database', () => {
  test('one player identifies a ROM and both players see it', async () => {
    const one = await loginDev('1');
    const two = await loginDev('2');

    const gameOne = await addGame(one, 'mystery-rom.sfc');
    const gameTwo = await addGame(two, 'same-dump-different-name.sfc');

    try {
      // Nothing recognises this dump, so the library says so rather than
      // pretending the filename is a title.
      expect((await libraryEntry(one, gameOne.id)).needsIdentification).toBe(true);

      const identified = await apiFetch(one, `/api/games/${gameOne.id}/identify`, {
        method: 'POST',
        body: JSON.stringify({
          entry: { title: 'Umihara Kawase', genre: 'Puzzle-Platform', publisher: 'TNN' }
        })
      });
      expect(identified.status).toBe(200);
      const { metadataId } = await identified.json();

      const forOne = await libraryEntry(one, gameOne.id);
      expect(forOne.title).toBe('Umihara Kawase');
      expect(forOne.genre).toBe('Puzzle-Platform');
      expect(forOne.needsIdentification).toBe(false);

      // The point of the whole feature: player two contributed nothing and
      // never reloaded anything, and their library is now correct too.
      const forTwo = await libraryEntry(two, gameTwo.id);
      expect(forTwo.title).toBe('Umihara Kawase');
      expect(forTwo.metadataId).toBe(metadataId);
      expect(forTwo.needsIdentification).toBe(false);

      // And the entry is now findable by everyone, not just its author.
      const found = await (await apiFetch(two, '/api/metadata/search?q=Umihara')).json();
      expect(found.map((m: { id: string }) => m.id)).toContain(metadataId);
    } finally {
      await apiFetch(one, `/api/games/${gameOne.id}`, { method: 'DELETE' });
      await apiFetch(two, `/api/games/${gameTwo.id}`, { method: 'DELETE' });
    }
  });

  test('a dump already claimed answers with what it is, not with a failure', async () => {
    const one = await loginDev('1');
    const two = await loginDev('2');
    const gameOne = await addGame(one, 'claimed.sfc');
    const gameTwo = await addGame(two, 'claimed-too.sfc');

    try {
      await apiFetch(one, `/api/games/${gameOne.id}/identify`, {
        method: 'POST',
        body: JSON.stringify({ entry: { title: 'First Answer' } })
      });

      const second = await apiFetch(two, `/api/games/${gameTwo.id}/identify`, {
        method: 'POST',
        body: JSON.stringify({ entry: { title: 'Second Answer' } })
      });

      expect(second.status).toBe(409);
      const payload = await second.json();
      // The client can say "already identified as X" instead of showing an
      // error the player cannot act on.
      expect(payload.metadata.title).toBe('First Answer');
    } finally {
      await apiFetch(one, `/api/games/${gameOne.id}`, { method: 'DELETE' });
      await apiFetch(two, `/api/games/${gameTwo.id}`, { method: 'DELETE' });
    }
  });

  test('a file that is not an image is refused as a cover', async () => {
    const cookie = await loginDev('1');
    const game = await addGame(cookie, 'cover-test.sfc');

    try {
      const identified = await apiFetch(cookie, `/api/games/${game.id}/identify`, {
        method: 'POST',
        body: JSON.stringify({ entry: { title: 'Cover Test' } })
      });
      const { metadataId } = await identified.json();

      const refused = await apiFetch(cookie, `/api/metadata/${metadataId}/cover`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: Buffer.from('<svg onload="alert(1)"></svg>')
      });

      // The declared type said PNG. The bytes decide.
      expect(refused.status).toBe(415);
    } finally {
      await apiFetch(cookie, `/api/games/${game.id}`, { method: 'DELETE' });
    }
  });
});
```

- [ ] **Step 2: Lancer l'e2e**

Run: `npm run test:e2e -- identify-game`
Expected: les trois tests passent. L'application doit tourner et `AUTH_MODE=dev` être actif, comme pour les autres specs.

- [ ] **Step 3: Lancer la suite complète**

Run: `npm run test:all`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e/identify-game.spec.ts
git commit -m "Pin down that a contribution reaches the player who did nothing"
```

---

## Vérification à la main

Une fois les neuf tâches passées, avec `docker compose up -d` :

1. Ajouter une ROM dont le titre n'est dans aucune entrée du catalogue. La carte porte le badge bleu « À identifier ».
2. Ouvrir la fiche, cliquer « Identifier ce jeu ». La recherche est déjà amorcée avec le nom du fichier.
3. Chercher un jeu du catalogue, cliquer un résultat. La modale se ferme, le badge disparaît, la carte affiche le titre du catalogue.
4. Sur une autre ROM inconnue, choisir « Aucun ne correspond — créer une fiche », remplir uniquement le titre, envoyer. La fiche est créée.
5. Recommencer avec une image de plus de 2 Mo : elle doit être acceptée (redimensionnée dans le navigateur), et la jaquette apparaître sur la carte.
6. Se connecter avec le second compte de développement, ajouter la même ROM : elle arrive déjà identifiée, sans badge.
7. Redémarrer le backend et confirmer que les entrées contribuées sont toujours là — c'est le chemin `loadGameMetadata`, qui ne doit plus compter que les lignes du catalogue.

## Notes d'exécution

- **Ordre imposé.** Les tâches 1 à 3 sont un socle : rien de la 4 à la 9 ne compile sans elles. Les tâches 4, 5 et 6 sont indépendantes entre elles. La 7 ne dépend d'aucune autre et peut être faite en parallèle du backend. La 8 a besoin de 3 à 7. La 9 a besoin de tout.
- **Ne pas déployer sans réfléchir à la migration.** Fusionner sur `main` est le déploiement, et le dépôt d'infrastructure privé lance les migrations. `0003_community_metadata.sql` doit être visible du service `db-migration`, qui monte `./backend/migrations` en lecture seule en dev mais lit le dossier **de l'image** en production (`docker-compose.prod.yml`) — donc l'image de production doit être reconstruite, pas seulement redémarrée.
