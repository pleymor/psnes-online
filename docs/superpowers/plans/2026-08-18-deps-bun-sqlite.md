# Alléger les dépendances, passer à Bun, sortir de Prisma — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retirer les dépendances mortes, faire installer Bun à la place de npm, et remplacer Prisma par `better-sqlite3` derrière des modules de dépôt testés.

**Architecture:** Trois phases séquentielles, du risque nul au risque réel. La phase 3 introduit `backend/src/db/` comme unique frontière entre le serveur et SQLite : cinq modules de dépôt exposant des fonctions nommées, un runner de migrations qui refuse de démarrer sur un schéma divergent, et aucun `import` de driver ailleurs dans le code.

**Tech Stack:** Node 20, TypeScript, better-sqlite3, Bun (installateur uniquement), Docker Compose, `node --test` avec tsx.

**Spec:** `docs/superpowers/specs/2026-08-18-deps-bun-sqlite-design.md`

## Global Constraints

- **Node reste le runtime.** Bun n'installe que. Aucun `bun run` hors des Dockerfiles, aucun `bun test`.
- **Les tests tournent avec `node --import tsx --test`**, comme les 12 suites existantes de `core/test`.
- **Aucun `import` de `better-sqlite3` en dehors de `backend/src/db/`.** C'est ce qui rendra la bascule vers `bun:sqlite` possible plus tard.
- **Les dates sont des entiers en base, des `Date` en mémoire.** Conversion `new Date(n)` en lecture, `.getTime()` en écriture, exclusivement dans les convertisseurs de ligne.
- **Prisma génère trois choses que SQL brut ne génère pas** : les `id` (`@default(uuid())`), les `createdAt` (`@default(now())`) et les `updatedAt` (`@updatedAt`). Chaque `INSERT` fournit les trois ; chaque `UPDATE` sur une table qui a `updatedAt` le fournit aussi.
- **`PRAGMA foreign_keys = ON` à chaque ouverture de connexion.** `DELETE FROM Game` compte sur la cascade pour emporter les `Save`.
- **Ne rien commiter sans l'accord explicite du propriétaire du dépôt** (`CLAUDE.md`). Les étapes « Commit » du plan préparent le message et attendent le feu vert.
- Format des messages de commit : impératif, en anglais, une ligne — le style de l'historique (`Restore rooms at boot and save them on the way out`).

## Structure des fichiers

**Phase 1 — modifiés**

- `frontend/package.json` — cinq dépendances retirées
- `frontend/vite.config.ts` — alias et `optimizeDeps` correspondants retirés

**Phase 2 — modifiés**

- `backend/Dockerfile`, `backend/dev.Dockerfile`, `frontend/Dockerfile` — Bun installe
- `docker-compose.yml` — les deux lignes `command:`
- `package.json` — workspaces

**Phase 3 — créés**

| Fichier | Responsabilité |
|---|---|
| `backend/src/db/sqlite.ts` | ouvrir la connexion, appliquer les pragmas, résoudre `DATABASE_URL` |
| `backend/src/db/types.ts` | les cinq interfaces de ligne, écrites à la main |
| `backend/src/db/migrate.ts` | le runner : baseline, comparaison de schéma, refus |
| `backend/src/db/migrate-cli.ts` | point d'entrée exécutable du service `db-migration` |
| `backend/migrations/0001_baseline.sql` | le schéma d'aujourd'hui |
| `backend/src/db/users.ts` | 9 fonctions |
| `backend/src/db/friendships.ts` | 9 fonctions, dont 4 jointures |
| `backend/src/db/games.ts` | 15 fonctions, dont 2 jointures |
| `backend/src/db/saves.ts` | 4 fonctions, dont 1 jointure |
| `backend/src/db/game-metadata.ts` | 5 fonctions |
| `backend/test/*.test.ts` | les suites, hors `tsconfig.json` qui n'inclut que `src/**/*` |

**Phase 3 — supprimés**

`backend/src/db/prisma.ts`, `backend/prisma/schema.prisma`, `backend/prisma/migrations/`, les dépendances `prisma` et `@prisma/client`, les scripts `db:generate` et `db:migrate`.

**Note de déviation par rapport à la spec.** La spec plaçait les migrations dans `backend/src/db/migrations/`. Elles vont dans `backend/migrations/` : `tsc` ne copie pas les fichiers `.sql` vers `dist/`, donc des migrations sous `src/` seraient absentes de l'image de production. `backend/migrations/` est copié explicitement par le Dockerfile, comme `backend/prisma` l'était.

---

## Phase 1 — Reliquat de #11

### Task 1: Retirer les dépendances frontend sans consommateur

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/vite.config.ts:8-25`

**Interfaces:**
- Consumes: rien
- Produces: rien — aucune autre tâche n'en dépend

- [ ] **Step 1: Relever la mesure de départ**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
du -sh node_modules
grep -c '"node_modules/' package-lock.json
```

Noter les deux valeurs. Attendu au moment de l'écriture : `257M` et `461`.

- [ ] **Step 2: Vérifier une dernière fois qu'aucun des cinq n'est importé**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
for p in "@sveltejs/adapter-auto" "@sveltejs/adapter-node" stream-browserify events util; do
  echo "-- $p"
  grep -rn "from '$p'\|require('$p')\|from \"$p\"" frontend/src core backend/src 2>/dev/null
done
grep -n "adapter-auto\|adapter-node" frontend/svelte.config.js
```

Attendu : aucune ligne de résultat pour les `grep -rn`, et rien non plus dans `svelte.config.js`, qui importe `@sveltejs/adapter-static`. Si l'un des cinq apparaît, **arrêter** et signaler : la prémisse de la tâche est fausse.

`events` et `util` méritent une attention particulière : ils sont aliasés vers eux-mêmes dans `vite.config.ts` (`events: 'events'`), donc un import de `'events'` résoudrait vers le package npm. Le `grep` ci-dessus le détecterait.

- [ ] **Step 3: Retirer les cinq dépendances**

Dans `frontend/package.json`, supprimer de `devDependencies` :

```json
    "@sveltejs/adapter-auto": "^3.1.1",
    "@sveltejs/adapter-node": "^5.0.1",
```

et de `dependencies` :

```json
    "events": "^3.3.0",
    "stream-browserify": "^3.0.0",
    "util": "^0.12.5",
```

- [ ] **Step 4: Retirer les alias correspondants**

Dans `frontend/vite.config.ts`, `resolve.alias` passe de :

```ts
    alias: {
      buffer: 'buffer/',
      stream: 'stream-browserify',
      events: 'events',
      util: 'util/',
      path: 'path-browserify',
    },
```

à :

```ts
    alias: {
      buffer: 'buffer/',
      path: 'path-browserify',
    },
```

et `optimizeDeps.include` de :

```ts
    include: ['simple-peer', 'buffer', 'process', 'events', 'util', 'stream-browserify', 'ini', 'path-browserify'],
```

à :

```ts
    include: ['simple-peer', 'buffer', 'process', 'ini', 'path-browserify'],
```

`buffer`, `process`, `ini` et `path-browserify` restent : `polyfills.ts` importe les deux premiers, `vendors.ts:1` importe `ini`, et `simple-peer` a besoin de `buffer` et `process`.

- [ ] **Step 5: Réinstaller et construire le frontend**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
npm install
npm run build --workspace=psnes-frontend
```

Attendu : le build passe. S'il échoue sur un module introuvable, c'est qu'un des cinq était utilisé par une dépendance transitive de `simple-peer` sans être importé directement — remettre celui-là seul et noter pourquoi.

- [ ] **Step 6: Vérifier que simple-peer fonctionne toujours dans le navigateur**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
npx playwright test --config e2e/playwright.config.ts
```

Attendu : la suite passe comme avant le changement. C'est le seul test qui exerce réellement le chemin WebRTC que les polyfills servent.

- [ ] **Step 7: Relever la mesure d'arrivée**

```bash
du -sh node_modules
grep -c '"node_modules/' package-lock.json
```

Consigner l'écart dans le message de commit.

- [ ] **Step 8: Commit (demander l'accord d'abord)**

```bash
git add frontend/package.json frontend/vite.config.ts package-lock.json
git commit -m "Drop five frontend packages nothing imported"
```

---

## Phase 2 — #10 Partie 1, Bun comme package manager

### Task 2: Faire installer Bun dans les trois Dockerfiles

**Files:**
- Modify: `backend/Dockerfile:5-8,20-26,41`
- Modify: `backend/dev.Dockerfile:1-16`
- Modify: `frontend/Dockerfile:1-22`

**Interfaces:**
- Consumes: rien
- Produces: des images où `bun` est sur le `PATH` et `bun.lockb` fait foi ; la Task 3 s'appuie dessus pour les `command:` de compose

- [ ] **Step 1: Générer le lockfile Bun localement**

Bun doit être présent sur la machine hôte pour produire `bun.lockb` :

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

Puis, à la racine du dépôt :

```bash
cd /home/pleymor/projects/psnes-repos/psnes
bun install
ls -la bun.lockb
```

Attendu : `bun.lockb` existe. `package-lock.json` reste au dépôt — la spec le garde jusqu'à ce que la phase soit jugée stable.

- [ ] **Step 2: Vérifier que le hoisting des workspaces n'a rien cassé**

C'est le risque propre au changement d'installateur : Bun et npm ne placent pas les paquets aux mêmes endroits.

```bash
cd /home/pleymor/projects/psnes-repos/psnes
ls node_modules/.bin/tsx node_modules/.bin/vite 2>&1
npm run test:all
```

Attendu : les binaires existent et les 12 suites passent. Si `tsx` est introuvable, le hoisting diffère — l'ajouter explicitement aux dépendances du workspace qui l'appelle plutôt que de contourner.

- [ ] **Step 3: Ajouter Bun à `backend/Dockerfile`**

L'image de base reste `node:20` : Node exécute toujours. Le binaire Bun est copié depuis l'image officielle, une couche déterministe qui ne se réinvalide pas à chaque build.

Remplacer l'en-tête de l'étape `prod-deps` :

```dockerfile
FROM node:20 AS prod-deps

WORKDIR /app
ENV NODE_ENV=build

COPY backend/package*.json ./
COPY package-lock.json ./

RUN npm ci --omit=dev --prefer-offline
```

par :

```dockerfile
FROM node:20 AS prod-deps

COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app
ENV NODE_ENV=build

COPY backend/package.json ./
COPY bun.lockb ./

RUN bun install --production --frozen-lockfile
```

- [ ] **Step 4: Basculer l'étape `builder` du même Dockerfile**

Remplacer :

```dockerfile
RUN npm ci --prefer-offline
```

par :

```dockerfile
RUN bun install --frozen-lockfile
```

et :

```dockerfile
RUN npm run build
```

par :

```dockerfile
RUN bun run build
```

`bun run build` invoque le script `build` du `package.json`, qui appelle `tsc` — c'est toujours TypeScript qui compile, et toujours Node qui exécutera le résultat.

- [ ] **Step 5: Basculer `backend/dev.Dockerfile`**

Ajouter la ligne de copie sous le `FROM`, puis remplacer `RUN npm install` par `RUN bun install` :

```dockerfile
FROM node:20

COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package.json ./
COPY bun.lockb ./
RUN bun install

COPY backend/prisma ./prisma
RUN npx prisma generate

CMD ["npm", "run", "dev"]
```

`npx prisma generate` reste ici : la phase 3 le supprimera. Le `CMD` reste sur `npm run dev` — il est de toute façon écrasé par le `command:` de compose, que la Task 3 traite.

- [ ] **Step 6: Basculer `frontend/Dockerfile`**

Ajouter la copie du binaire sous le `FROM builder`, puis remplacer :

```dockerfile
COPY package*.json ./
RUN npm install && \
    npm cache clean --force
```

par :

```dockerfile
COPY package.json ./
RUN bun install
```

(`bun cache clean` n'a pas d'équivalent utile ici : le cache de Bun vit hors du répertoire de travail et ne gonfle pas la couche.)

Puis remplacer `RUN npm run build` par `RUN bun run build`, et `RUN npx svelte-kit sync` par `RUN bunx svelte-kit sync`.

- [ ] **Step 7: Construire les trois images**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
docker compose build
docker compose -f docker-compose.prod.yml build
```

Attendu : les deux builds réussissent. L'échec le plus probable est `bun.lockb` absent du contexte de build — le `.dockerignore`, s'il existe, doit le laisser passer.

- [ ] **Step 8: Commit (demander l'accord d'abord)**

```bash
git add backend/Dockerfile backend/dev.Dockerfile frontend/Dockerfile bun.lockb
git commit -m "Let Bun install what npm used to"
```

### Task 3: Remplacer les `npm install` au démarrage des conteneurs

**Files:**
- Modify: `docker-compose.yml:47,64`
- Modify: `package.json:4-7`

**Interfaces:**
- Consumes: les images de la Task 2, où `bun` est sur le `PATH`
- Produces: un `docker compose up` qui ne réinstalle plus 461 paquets à chaque démarrage

- [ ] **Step 1: Basculer le `command:` du backend**

`docker-compose.yml`, service `backend`, remplacer :

```yaml
    command: sh -c "npm install && npx prisma generate && npm run dev"
```

par :

```yaml
    command: sh -c "bun install && npx prisma generate && npm run dev"
```

`npm run dev` est conservé volontairement : il lance `tsx watch src/index.ts`, exécuté par Node. Seule l'installation change.

- [ ] **Step 2: Basculer le `command:` du frontend**

Même fichier, service `frontend`, remplacer :

```yaml
    command: sh -c "npm install && npm run dev -- --host"
```

par :

```yaml
    command: sh -c "bun install && npm run dev -- --host"
```

Ce service utilise l'image `node:20-alpine` brute, pas un Dockerfile — Bun n'y est donc pas, et `bun install` échouerait. Il lui faut une image qui porte les deux : Bun pour installer, Node pour exécuter Vite. Basculer `oven/bun:1` ne conviendrait pas, cette image n'embarque pas Node.

Donner au frontend un Dockerfile de développement symétrique de `backend/dev.Dockerfile`. Créer `frontend/dev.Dockerfile` :

```dockerfile
FROM node:20

COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

CMD ["npm", "run", "dev", "--", "--host"]
```

et dans `docker-compose.yml`, service `frontend`, remplacer `image: node:20-alpine` par :

```yaml
    build:
      context: .
      dockerfile: frontend/dev.Dockerfile
```

en gardant `command: sh -c "bun install && npm run dev -- --host"`.

- [ ] **Step 3: Convertir les workspaces**

Bun lit le champ `workspaces` de `package.json` avec la même syntaxe que npm — aucun changement n'est nécessaire à ce champ. Vérifier seulement qu'il est bien pris en compte :

```bash
cd /home/pleymor/projects/psnes-repos/psnes
bun install
ls -d node_modules/psnes-backend node_modules/psnes-frontend
```

Attendu : les deux liens symboliques de workspace existent. Si Bun ne les crée pas, c'est la seule divergence de workspaces qui compte ici — la signaler plutôt que de la contourner.

- [ ] **Step 4: Mesurer le gain, qui est l'objet de l'issue**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
docker compose down -v
time docker compose up -d
docker compose logs backend | head -30
```

Attendu : la pile démarre, et le temps d'installation au démarrage a nettement baissé. Consigner la valeur : c'est la preuve que #10 demandait.

- [ ] **Step 5: Vérifier que rien n'a régressé**

```bash
npm run test:all
npx playwright test --config e2e/playwright.config.ts
```

Attendu : 12 suites `core/test` passantes, suite Playwright passante. Les scripts de test n'ont pas changé — ils tournent toujours sous `node --import tsx --test`.

- [ ] **Step 6: Commit (demander l'accord d'abord)**

```bash
git add docker-compose.yml frontend/dev.Dockerfile
git commit -m "Stop reinstalling 461 packages on every container start"
```

---

## Phase 3 — #13, Prisma → better-sqlite3

### Task 4: Ouvrir une connexion SQLite, avec ses pragmas

**Files:**
- Create: `backend/src/db/sqlite.ts`
- Create: `backend/test/sqlite.test.ts`
- Modify: `backend/package.json` (dépendances et script de test)
- Modify: `package.json` (script `test:backend`)

**Interfaces:**
- Consumes: rien
- Produces:
  - `openDatabase(file: string): Database` — ouvre, applique les pragmas
  - `databaseFileFromUrl(url: string): string` — `file:/app/data/dev.db` → `/app/data/dev.db`
  - `getDb(): Database` — la connexion du processus, ouverte à la première demande depuis `DATABASE_URL`
  - `closeDb(): void` — pour les tests
  - `type Database` — ré-export du type de better-sqlite3, pour que rien d'autre n'ait à l'importer

- [ ] **Step 1: Installer better-sqlite3 et ses types**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
bun add --cwd backend better-sqlite3
bun add --cwd backend --dev @types/better-sqlite3
```

Si `bun add --cwd` n'est pas disponible dans la version installée, éditer `backend/package.json` à la main et relancer `bun install` à la racine.

- [ ] **Step 2: Ajouter le script de test backend**

Dans `package.json` à la racine, ajouter à `scripts` :

```json
    "test:backend": "node --import tsx --test backend/test/*.test.ts",
```

et étendre `test:all` :

```json
    "test:all": "npm run test:netplay && npm run test:core && npm run test:ui && npm run test:backend"
```

Les tests vivent dans `backend/test/`, hors du `include: ["src/**/*"]` de `backend/tsconfig.json` — ils ne partiront donc pas dans `dist/`.

- [ ] **Step 3: Écrire le test qui échoue**

Créer `backend/test/sqlite.test.ts` :

```ts
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
```

Le test des clés étrangères n'est pas décoratif : SQLite les désactive par défaut, et `games.ts:154` supprime un jeu en comptant sur la cascade pour emporter ses sauvegardes. Sans ce pragma, les `Save` deviendraient orphelines en silence.

- [ ] **Step 4: Lancer le test pour le voir échouer**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
node --import tsx --test backend/test/sqlite.test.ts
```

Attendu : ÉCHEC — `Cannot find module '../src/db/sqlite.js'`.

- [ ] **Step 5: Écrire l'implémentation minimale**

Créer `backend/src/db/sqlite.ts` :

```ts
import BetterSqlite3 from 'better-sqlite3';

export type Database = BetterSqlite3.Database;

/**
 * Prisma addressed the database through a `file:` URL. The environment still
 * carries that form in DATABASE_URL, in compose files and in deployments we do
 * not control, so we keep reading it rather than asking every deployment to
 * change on the same day as the driver.
 */
export function databaseFileFromUrl(url: string): string {
  return url.startsWith('file:') ? url.slice('file:'.length) : url;
}

export function openDatabase(file: string): Database {
  const db = new BetterSqlite3(file);
  // SQLite ships with foreign keys off. Deleting a Game relies on the cascade
  // to take its Saves with it, so this is load-bearing, not hygiene.
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  return db;
}

let instance: Database | null = null;

export function getDb(): Database {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set');
    }
    instance = openDatabase(databaseFileFromUrl(url));
  }
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}
```

- [ ] **Step 6: Lancer le test pour le voir passer**

```bash
node --import tsx --test backend/test/sqlite.test.ts
```

Attendu : 4 tests passants.

- [ ] **Step 7: Commit (demander l'accord d'abord)**

```bash
git add backend/src/db/sqlite.ts backend/test/sqlite.test.ts backend/package.json package.json bun.lockb
git commit -m "Open SQLite directly, with the pragmas cascades need"
```

### Task 5: Écrire les types de ligne à la main

**Files:**
- Create: `backend/src/db/types.ts`
- Create: `backend/migrations/0001_baseline.sql`

**Interfaces:**
- Consumes: rien
- Produces: `User`, `Game`, `Save`, `Friendship`, `GameMetadata` — les cinq interfaces que tous les modules de dépôt renvoient

- [ ] **Step 1: Produire la baseline depuis la base de référence**

La baseline doit décrire exactement ce que les huit migrations Prisma produisent, sans être écrite à la main. La fabriquer :

```bash
cd /home/pleymor/projects/psnes-repos/psnes/backend
export DATABASE_URL="file:/tmp/psnes-baseline.db"
rm -f /tmp/psnes-baseline.db
npx prisma migrate deploy
node --input-type=module -e "
import BetterSqlite3 from 'better-sqlite3';
const db = new BetterSqlite3('/tmp/psnes-baseline.db');
const rows = db.prepare(\`
  SELECT sql FROM sqlite_master
  WHERE sql IS NOT NULL
    AND name NOT LIKE 'sqlite_%'
    AND name != '_prisma_migrations'
  ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name
\`).all();
console.log(rows.map(r => r.sql + ';').join('\n\n'));
" > migrations/0001_baseline.sql
head -20 migrations/0001_baseline.sql
```

Créer le répertoire d'abord si besoin (`mkdir -p backend/migrations`). Attendu : un fichier contenant les `CREATE TABLE` de `User`, `Friendship`, `GameMetadata`, `Game`, `Save` puis les `CREATE INDEX` / `CREATE UNIQUE INDEX`.

L'ordre compte : les tables avant les index, et `User` avant `Friendship` et `Game` qui la référencent. Le `ORDER BY` ci-dessus met les tables en premier ; vérifier à l'œil que `User` précède ses dépendants et réordonner sinon.

- [ ] **Step 2: Écrire les interfaces**

Créer `backend/src/db/types.ts` :

```ts
/**
 * The row shapes, written by hand now that no generator writes them.
 *
 * Dates are `Date` here and integers on disk: SQLite has no date type, and
 * Prisma stored every DATETIME column as milliseconds since the epoch. The
 * conversion lives in the row converters of each repository module, nowhere
 * else.
 */

export interface User {
  id: string;
  googleId: string;
  email: string;
  displayName: string;
  avatar: string | null;
  controlsConfig: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What the friend search and the online-friends list are allowed to expose. */
export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  avatar: string | null;
}

export interface Friendship {
  id: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  initiatorId: string;
  receiverId: string;
}

export interface Game {
  id: string;
  title: string;
  filename: string;
  coverUrl: string | null;
  uploadedAt: Date;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  crc32: string | null;
  sram: Buffer | null;
  sramUpdatedAt: Date | null;
  userId: string;
}

export interface Save {
  id: string;
  name: string;
  slotNumber: number;
  data: Buffer;
  screenshot: string | null;
  createdAt: Date;
  updatedAt: Date;
  gameId: string;
}

/** The subset of a Save that the library listing sends: never the blob. */
export interface SaveSummary {
  id: string;
  name: string;
  slotNumber: number;
  screenshot: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GameMetadata {
  id: string;
  title: string;
  altTitle: string | null;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  coverUrl: string | null;
  crc32: string | null;
  md5: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 3: Vérifier que les interfaces couvrent le schéma, colonne par colonne**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
node --input-type=module -e "
import BetterSqlite3 from 'better-sqlite3';
const db = new BetterSqlite3('/tmp/psnes-baseline.db');
for (const t of ['User','Friendship','Game','Save','GameMetadata']) {
  const cols = db.prepare(\`PRAGMA table_info('\${t}')\`).all();
  console.log(t + ': ' + cols.map(c => c.name + (c.notnull ? '' : '?')).join(', '));
}
"
```

Attendu : chaque colonne listée a son champ dans `types.ts`, et les colonnes marquées `?` (nullable) sont typées `| null`. Corriger toute divergence maintenant — une interface fausse ici se propage aux cinq modules.

- [ ] **Step 4: Commit (demander l'accord d'abord)**

```bash
git add backend/src/db/types.ts backend/migrations/0001_baseline.sql
git commit -m "Write down the row shapes a generator used to write"
```

### Task 6: Le runner de migrations, et son refus de démarrer

**Files:**
- Create: `backend/src/db/migrate.ts`
- Create: `backend/test/migrate.test.ts`

**Interfaces:**
- Consumes: `openDatabase` de `backend/src/db/sqlite.ts`
- Produces:
  - `migrate(db: Database, migrationsDir: string): MigrationResult`
  - `interface MigrationResult { applied: string[]; baselined: string[] }`
  - `class SchemaDriftError extends Error` — porte `.differences: string[]`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `backend/test/migrate.test.ts` :

```ts
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
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
node --import tsx --test backend/test/migrate.test.ts
```

Attendu : ÉCHEC — `Cannot find module '../src/db/migrate.js'`.

- [ ] **Step 3: Écrire l'implémentation**

Créer `backend/src/db/migrate.ts` :

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './sqlite.js';
import BetterSqlite3 from 'better-sqlite3';

export interface MigrationResult {
  /** Migrations whose SQL was executed. */
  applied: string[];
  /** Migrations recorded as already present, because the schema was there. */
  baselined: string[];
}

export class SchemaDriftError extends Error {
  constructor(public readonly differences: string[]) {
    super(
      'The database schema does not match what the migrations produce. ' +
      'Refusing to start rather than record a baseline that is not true.\n\n' +
      differences.join('\n')
    );
    this.name = 'SchemaDriftError';
  }
}

function ensureBookkeeping(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

function listMigrations(dir: string): string[] {
  return readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
}

function alreadyRecorded(db: Database): Set<string> {
  const rows = db.prepare(`SELECT name FROM schema_migrations`).all() as { name: string }[];
  return new Set(rows.map(r => r.name));
}

/** The schema as SQLite itself describes it, normalised so whitespace does not matter. */
function schemaOf(db: Database): Map<string, string> {
  const rows = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('_prisma_migrations', 'schema_migrations')
  `).all() as { name: string; sql: string }[];

  return new Map(rows.map(r => [r.name, r.sql.replace(/\s+/g, ' ').trim()]));
}

/** Does this database already carry a schema, or is it blank? */
function hasExistingSchema(db: Database): boolean {
  return schemaOf(db).size > 0;
}

/**
 * What the baseline alone would produce, built in memory so nothing on disk is
 * touched by the check.
 */
function expectedBaselineSchema(baselineSql: string): Map<string, string> {
  const probe: Database = new BetterSqlite3(':memory:');
  try {
    probe.exec(baselineSql);
    return schemaOf(probe);
  } finally {
    probe.close();
  }
}

function diffSchemas(live: Map<string, string>, expected: Map<string, string>): string[] {
  const differences: string[] = [];
  for (const [name, sql] of expected) {
    if (!live.has(name)) {
      differences.push(`missing from the database: ${name}`);
    } else if (live.get(name) !== sql) {
      differences.push(
        `different definition for ${name}:\n  database:   ${live.get(name)}\n  migrations: ${sql}`
      );
    }
  }
  for (const name of live.keys()) {
    if (!expected.has(name)) {
      differences.push(`present in the database but not in the migrations: ${name}`);
    }
  }
  return differences;
}

/**
 * Brings the database up to date.
 *
 * On a blank database every migration runs. On a database that already carries
 * a schema - the one Prisma left behind - the baseline is compared against what
 * it would produce and recorded only if they match; a mismatch throws rather
 * than being stamped over. That refusal is the point: #7 was not about `db
 * push` applying a schema, it was about nobody checking that the live database
 * matched the files.
 */
export function migrate(db: Database, migrationsDir: string): MigrationResult {
  const files = listMigrations(migrationsDir);
  if (files.length === 0) {
    throw new Error(`No migrations found in ${migrationsDir}`);
  }

  const needsBaseline = !db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
    .get() && hasExistingSchema(db);

  ensureBookkeeping(db);

  const result: MigrationResult = { applied: [], baselined: [] };
  const recorded = alreadyRecorded(db);
  const [baselineFile, ...rest] = files;

  if (needsBaseline) {
    const baselineSql = readFileSync(join(migrationsDir, baselineFile), 'utf-8');
    const differences = diffSchemas(schemaOf(db), expectedBaselineSchema(baselineSql));
    if (differences.length > 0) {
      throw new SchemaDriftError(differences);
    }
    db.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`)
      .run(baselineFile, Date.now());
    result.baselined.push(baselineFile);
    recorded.add(baselineFile);
  }

  for (const file of [baselineFile, ...rest]) {
    if (recorded.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    // Each migration is its own transaction: a failure rolls back that
    // migration and leaves the ones before it recorded.
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`)
        .run(file, Date.now());
    });
    run();
    result.applied.push(file);
  }

  return result;
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

```bash
node --import tsx --test backend/test/migrate.test.ts
```

Attendu : 6 tests passants. Si « a failing migration leaves the database untouched » échoue, c'est que `db.exec` d'un script multi-instructions ne se laisse pas envelopper dans la transaction de better-sqlite3 — le cas échéant, découper le script sur les `;` et exécuter chaque instruction par `db.prepare().run()` dans la transaction.

- [ ] **Step 5: Vérifier le runner contre la vraie baseline**

Le test précédent utilise une table `Widget` inventée. Celui-ci confronte le runner au schéma réel :

```bash
cd /home/pleymor/projects/psnes-repos/psnes/backend
rm -f /tmp/psnes-real.db
export DATABASE_URL="file:/tmp/psnes-real.db"
npx prisma migrate deploy
node --import tsx -e "
import { openDatabase } from './src/db/sqlite.js';
import { migrate } from './src/db/migrate.js';
const db = openDatabase('/tmp/psnes-real.db');
console.log(migrate(db, './migrations'));
"
```

Attendu : `{ applied: [], baselined: [ '0001_baseline.sql' ] }`. Un `SchemaDriftError` signifierait que la baseline générée à la Task 5 ne reproduit pas ce que les migrations Prisma produisent — corriger la baseline, pas le runner.

- [ ] **Step 6: Commit (demander l'accord d'abord)**

```bash
git add backend/src/db/migrate.ts backend/test/migrate.test.ts
git commit -m "Refuse to start when the schema is not what the migrations say"
```

### Task 7: Le point d'entrée du service de migration

**Files:**
- Create: `backend/src/db/migrate-cli.ts`
- Modify: `backend/Dockerfile` (copier `migrations/`)
- Modify: `docker-compose.yml:19`
- Modify: `docker-compose.prod.yml:19`

**Interfaces:**
- Consumes: `migrate`, `SchemaDriftError`, `getDb`, `databaseFileFromUrl`
- Produces: `dist/db/migrate-cli.js`, exécutable par `node`, code de sortie 1 en cas de dérive

- [ ] **Step 1: Écrire le CLI**

Créer `backend/src/db/migrate-cli.ts` :

```ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getDb } from './sqlite.js';
import { migrate, SchemaDriftError } from './migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/db/migrate-cli.js -> /app/migrations
const migrationsDir = join(here, '../../migrations');

try {
  const result = migrate(getDb(), migrationsDir);
  for (const name of result.baselined) {
    console.log(`baselined ${name} (schema already present and matching)`);
  }
  for (const name of result.applied) {
    console.log(`applied ${name}`);
  }
  if (result.applied.length === 0 && result.baselined.length === 0) {
    console.log('database is up to date');
  }
  process.exit(0);
} catch (error) {
  if (error instanceof SchemaDriftError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
```

- [ ] **Step 2: Copier les migrations dans l'image**

Dans `backend/Dockerfile`, étape `production`, remplacer :

```dockerfile
# Copy Prisma schema and runtime dependencies from builder stage
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
```

par :

```dockerfile
COPY backend/migrations ./migrations
```

- [ ] **Step 3: Vérifier que le binaire natif de better-sqlite3 survit au multi-étage**

**Amendé après la Task 4, qui a changé la nature de la question.** Le binaire ne vient pas d'une compilation mais d'un binaire pré-construit récupéré par `scripts/fetch-better-sqlite3-prebuild.sh` : `prebuild-install` refuse de tourner sous Bun, et Bun remplace `node` par son propre shim pour les scripts de cycle de vie. Surtout, `bun install --filter` **n'exécute pas** le `postinstall` du paquet racine, et Bun n'exécute jamais celui d'un membre du workspace — d'où les étapes `RUN … && sh scripts/fetch-better-sqlite3-prebuild.sh` ajoutées après chaque installation filtrée dans les deux Dockerfiles backend.

La question n'est donc plus « un compilateur est-il présent » mais « le binaire atterrit-il dans l'image ». Et elle ne se vérifie pas en constatant qu'un fichier existe : construire l'image et y exécuter un `require` réel.

```bash
cd /home/pleymor/projects/psnes-repos/psnes
docker build -f backend/Dockerfile --target production -t psnes-backend-probe .
docker run --rm --entrypoint node psnes-backend-probe \
  -e "const D=require('better-sqlite3'); new D(':memory:').exec('CREATE TABLE t(x)'); console.log('ok')"
```

Attendu : `ok`. Le `.node` doit aussi rester compatible entre l'étape `prod-deps` (`node:20`, Debian bookworm) et l'étape d'exécution (`node:20-trixie-slim`) — glibc étant rétrocompatible, un binaire construit sur bookworm tourne sur trixie, mais c'est ce `require` qui le prouve, pas ce raisonnement.

```bash
cd /home/pleymor/projects/psnes-repos/psnes
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml run --rm --entrypoint sh backend -c \
  "node -e \"const D=require('better-sqlite3'); const d=new D(':memory:'); d.exec('CREATE TABLE t(x)'); console.log('better-sqlite3 loads');\""
```

Attendu : `better-sqlite3 loads`. En cas d'échec sur une version de GLIBC ou un `.node` introuvable, ajouter une reconstruction explicite dans l'étape `prod-deps` (`RUN npm rebuild better-sqlite3`) — la chaîne `python3 make g++` y est déjà installée pour l'étape `builder`, il faut la remonter dans `prod-deps`.

- [ ] **Step 4: Basculer les deux services `db-migration`**

Dans `docker-compose.yml` et `docker-compose.prod.yml`, remplacer :

```yaml
    command: npx prisma migrate deploy
```

par :

```yaml
    command: node dist/db/migrate-cli.js
```

- [ ] **Step 5: Vérifier le comportement de bout en bout, y compris le refus**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
docker compose -f docker-compose.prod.yml up db-migration
```

Attendu sur un volume vierge : `applied 0001_baseline.sql`, sortie 0. Sur un volume qui porte déjà le schéma : `baselined 0001_baseline.sql`.

Puis provoquer une dérive délibérément et vérifier le refus :

```bash
docker compose -f docker-compose.prod.yml run --rm --entrypoint sh db-migration -c \
  "node -e \"const D=require('better-sqlite3'); const d=new D('/app/data/prod.db'); d.exec('ALTER TABLE Game ADD COLUMN drift TEXT');\" && node dist/db/migrate-cli.js; echo exit=\$?"
```

Attendu : le message de dérive nomme `Game`, et `exit=1`. Retirer ensuite la colonne (`ALTER TABLE Game DROP COLUMN drift`) ou recréer le volume.

Ce test est le seul qui prouve que la garantie de la spec tient dans les conditions réelles, avec le vrai schéma et le vrai chemin de fichier. Ne pas le sauter.

- [ ] **Step 6: Commit (demander l'accord d'abord)**

```bash
git add backend/src/db/migrate-cli.ts backend/Dockerfile docker-compose.yml docker-compose.prod.yml
git commit -m "Hand the migration service a runner that checks before it stamps"
```

### Task 8: Le dépôt des utilisateurs

**Files:**
- Create: `backend/src/db/users.ts`
- Create: `backend/test/users.test.ts`
- Create: `backend/test/helpers.ts`

**Interfaces:**
- Consumes: `getDb`/`openDatabase`, `migrate`, les types de `types.ts`
- Produces:
  - `findUserById(id: string): User | null`
  - `findUserByGoogleId(googleId: string): User | null`
  - `findUserByEmail(email: string): User | null`
  - `createUser(input: { googleId: string; email: string; displayName: string; avatar: string | null }): User`
  - `updateUserProfile(id: string, input: { displayName: string; avatar: string | null }): User`
  - `upsertDevUser(input: { id: string; googleId: string; email: string; displayName: string; avatar: string }): User`
  - `findControlsConfig(userId: string): string | null`
  - `updateControlsConfig(userId: string, json: string): void`
  - `searchUsers(excludeUserId: string, query: string, limit: number): UserSummary[]`

- [ ] **Step 1: Écrire le harnais de test partagé**

Créer `backend/test/helpers.ts` :

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase, type Database } from '../src/db/sqlite.js';
import { migrate } from '../src/db/migrate.js';

/**
 * A real database on a real file, migrated from the real baseline. Nothing is
 * mocked: these tests are the only thing standing between 50 rewritten queries
 * and production.
 */
export function migratedDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), 'psnes-repo-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db, resolve(import.meta.dirname, '../migrations'));
  return db;
}

export function insertUser(db: Database, over: Partial<{ id: string; googleId: string; email: string; displayName: string; avatar: string | null }> = {}) {
  const now = Date.now();
  const row = {
    id: over.id ?? `user-${Math.floor(now * Math.random())}`,
    googleId: over.googleId ?? `g-${Math.floor(now * Math.random())}`,
    email: over.email ?? `u${Math.floor(now * Math.random())}@example.test`,
    displayName: over.displayName ?? 'Test User',
    avatar: over.avatar ?? null
  };
  db.prepare(`
    INSERT INTO "User" (id, googleId, email, displayName, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (@id, @googleId, @email, @displayName, @avatar, NULL, @now, @now)
  `).run({ ...row, now });
  return row;
}
```

`import.meta.dirname` demande Node 20.11+. La machine tourne sous v20.19.6 ; sous une version plus ancienne, utiliser `dirname(fileURLToPath(import.meta.url))`.

- [ ] **Step 2: Écrire les tests qui échouent**

Créer `backend/test/users.test.ts` :

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  findUserById, findUserByGoogleId, findUserByEmail, createUser,
  updateUserProfile, upsertDevUser, findControlsConfig, updateControlsConfig,
  searchUsers
} from '../src/db/users.js';

test('createUser generates an id and both timestamps', () => {
  const db = migratedDb();
  const user = createUser(db, {
    googleId: 'g-1', email: 'a@example.test', displayName: 'Ada', avatar: null
  });

  assert.ok(user.id.length > 0, 'an id should have been generated');
  assert.ok(user.createdAt instanceof Date);
  assert.ok(user.updatedAt instanceof Date);
  assert.equal(user.avatar, null);
  assert.equal(user.controlsConfig, null);
});

test('dates come back as Date, and are integers on disk', () => {
  const db = migratedDb();
  const user = createUser(db, {
    googleId: 'g-2', email: 'b@example.test', displayName: 'Bo', avatar: null
  });

  const raw = db.prepare(`SELECT typeof(createdAt) AS t FROM "User" WHERE id = ?`)
    .get(user.id) as { t: string };
  assert.equal(raw.t, 'integer', 'Prisma stored dates as epoch millis; so do we');

  const read = findUserById(db, user.id);
  assert.ok(read!.createdAt instanceof Date);
  assert.equal(read!.createdAt.getTime(), user.createdAt.getTime());
});

test('findUserById returns null rather than throwing on a missing row', () => {
  const db = migratedDb();
  assert.equal(findUserById(db, 'nobody'), null);
});

test('findUserByGoogleId and findUserByEmail find the same row', () => {
  const db = migratedDb();
  const created = createUser(db, {
    googleId: 'g-3', email: 'c@example.test', displayName: 'Cy', avatar: null
  });

  assert.equal(findUserByGoogleId(db, 'g-3')!.id, created.id);
  assert.equal(findUserByEmail(db, 'c@example.test')!.id, created.id);
  assert.equal(findUserByGoogleId(db, 'absent'), null);
});

test('updateUserProfile moves updatedAt forward, which Prisma used to do for us', async () => {
  const db = migratedDb();
  const created = createUser(db, {
    googleId: 'g-4', email: 'd@example.test', displayName: 'Di', avatar: null
  });
  await new Promise(r => setTimeout(r, 5));

  const updated = updateUserProfile(db, created.id, { displayName: 'Dee', avatar: 'a.png' });

  assert.equal(updated.displayName, 'Dee');
  assert.equal(updated.avatar, 'a.png');
  assert.ok(
    updated.updatedAt.getTime() > created.updatedAt.getTime(),
    'updatedAt must advance: @updatedAt is gone and nothing else will do it'
  );
});

test('upsertDevUser creates then updates only the avatar', () => {
  const db = migratedDb();
  const input = {
    id: 'dev-user-1', googleId: 'dev-google-id-1',
    email: 'user1@dev.local', displayName: 'Dev User 1', avatar: 'first.svg'
  };

  const created = upsertDevUser(db, input);
  assert.equal(created.avatar, 'first.svg');

  const updated = upsertDevUser(db, { ...input, displayName: 'Ignored', avatar: 'second.svg' });
  assert.equal(updated.id, 'dev-user-1');
  assert.equal(updated.avatar, 'second.svg');
  assert.equal(updated.displayName, 'Dev User 1', 'only the avatar is refreshed, as before');

  const count = db.prepare(`SELECT COUNT(*) AS n FROM "User"`).get() as { n: number };
  assert.equal(count.n, 1);
});

test('controls config round-trips as an opaque JSON string', () => {
  const db = migratedDb();
  const user = insertUser(db);

  assert.equal(findControlsConfig(db, user.id), null);

  updateControlsConfig(db, user.id, '{"up":"ArrowUp"}');
  assert.equal(findControlsConfig(db, user.id), '{"up":"ArrowUp"}');
});

test('searchUsers matches email or display name, excludes the caller, and caps results', () => {
  const db = migratedDb();
  const me = insertUser(db, { displayName: 'Searcher', email: 'me@example.test' });
  insertUser(db, { displayName: 'Mario Fan', email: 'mario@example.test' });
  insertUser(db, { displayName: 'Someone', email: 'zelda@example.test' });

  const byName = searchUsers(db, me.id, 'Mario', 10);
  assert.equal(byName.length, 1);
  assert.equal(byName[0].displayName, 'Mario Fan');

  const byEmail = searchUsers(db, me.id, 'zelda', 10);
  assert.equal(byEmail.length, 1);

  const self = searchUsers(db, me.id, 'Searcher', 10);
  assert.equal(self.length, 0, 'the caller is never their own suggestion');

  const capped = searchUsers(db, me.id, 'example.test', 1);
  assert.equal(capped.length, 1);
});

test('searchUsers never exposes googleId or timestamps', () => {
  const db = migratedDb();
  const me = insertUser(db);
  insertUser(db, { displayName: 'Visible' });

  const [found] = searchUsers(db, me.id, 'Visible', 10);
  assert.deepEqual(Object.keys(found).sort(), ['avatar', 'displayName', 'email', 'id']);
});
```

- [ ] **Step 3: Lancer les tests pour les voir échouer**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
node --import tsx --test backend/test/users.test.ts
```

Attendu : ÉCHEC — `Cannot find module '../src/db/users.js'`.

- [ ] **Step 4: Écrire l'implémentation**

Créer `backend/src/db/users.ts` :

```ts
import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { User, UserSummary } from './types.js';

interface UserRow {
  id: string;
  googleId: string;
  email: string;
  displayName: string;
  avatar: string | null;
  controlsConfig: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The one place a User row becomes a User. */
function toUser(row: UserRow): User {
  return {
    id: row.id,
    googleId: row.googleId,
    email: row.email,
    displayName: row.displayName,
    avatar: row.avatar,
    controlsConfig: row.controlsConfig,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}

const SELECT = `SELECT * FROM "User"`;

export function findUserById(db: Database, id: string): User | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function findUserByGoogleId(db: Database, googleId: string): User | null {
  const row = db.prepare(`${SELECT} WHERE googleId = ?`).get(googleId) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function findUserByEmail(db: Database, email: string): User | null {
  const row = db.prepare(`${SELECT} WHERE email = ?`).get(email) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function createUser(
  db: Database,
  input: { googleId: string; email: string; displayName: string; avatar: string | null }
): User {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO "User" (id, googleId, email, displayName, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(id, input.googleId, input.email, input.displayName, input.avatar, now, now);
  return findUserById(db, id)!;
}

export function updateUserProfile(
  db: Database,
  id: string,
  input: { displayName: string; avatar: string | null }
): User {
  db.prepare(`
    UPDATE "User" SET displayName = ?, avatar = ?, updatedAt = ? WHERE id = ?
  `).run(input.displayName, input.avatar, Date.now(), id);
  return findUserById(db, id)!;
}

/**
 * The dev-login shortcut. Creates the fixed dev user, or refreshes nothing but
 * its avatar - matching what the Prisma upsert did.
 */
export function upsertDevUser(
  db: Database,
  input: { id: string; googleId: string; email: string; displayName: string; avatar: string }
): User {
  const now = Date.now();
  db.prepare(`
    INSERT INTO "User" (id, googleId, email, displayName, avatar, controlsConfig, createdAt, updatedAt)
    VALUES (@id, @googleId, @email, @displayName, @avatar, NULL, @now, @now)
    ON CONFLICT(id) DO UPDATE SET avatar = @avatar, updatedAt = @now
  `).run({ ...input, now });
  return findUserById(db, input.id)!;
}

export function findControlsConfig(db: Database, userId: string): string | null {
  const row = db.prepare(`SELECT controlsConfig FROM "User" WHERE id = ?`)
    .get(userId) as { controlsConfig: string | null } | undefined;
  return row?.controlsConfig ?? null;
}

export function updateControlsConfig(db: Database, userId: string, json: string): void {
  db.prepare(`UPDATE "User" SET controlsConfig = ?, updatedAt = ? WHERE id = ?`)
    .run(json, Date.now(), userId);
}

/**
 * Friend suggestions. Returns only what the client is allowed to see - never
 * googleId, never the timestamps - which the old `select:` clause guaranteed
 * and a `SELECT *` would quietly give away.
 */
export function searchUsers(
  db: Database,
  excludeUserId: string,
  query: string,
  limit: number
): UserSummary[] {
  return db.prepare(`
    SELECT id, email, displayName, avatar FROM "User"
    WHERE id != ?
      AND (email LIKE '%' || ? || '%' OR displayName LIKE '%' || ? || '%')
    LIMIT ?
  `).all(excludeUserId, query, query, limit) as UserSummary[];
}
```

Les fonctions prennent `db` en premier paramètre plutôt que d'appeler `getDb()` elles-mêmes : c'est ce qui rend les tests possibles sans variable d'environnement ni singleton à réinitialiser.

- [ ] **Step 5: Lancer les tests pour les voir passer**

```bash
node --import tsx --test backend/test/users.test.ts
```

Attendu : 9 tests passants.

- [ ] **Step 6: Commit (demander l'accord d'abord)**

```bash
git add backend/src/db/users.ts backend/test/users.test.ts backend/test/helpers.ts
git commit -m "Give users a repository that hands back Dates and hides googleId"
```

### Task 9: Le dépôt des amitiés, avec ses quatre jointures

**Files:**
- Create: `backend/src/db/friendships.ts`
- Create: `backend/test/friendships.test.ts`

**Interfaces:**
- Consumes: `Database`, `User`, `Friendship` ; `insertUser` du harnais
- Produces:
  - `interface FriendshipWithProfiles extends Friendship { initiator: User; receiver: User }`
  - `interface FriendshipWithInitiator extends Friendship { initiator: User }`
  - `listAcceptedFriendshipsFor(db, userId): Friendship[]`
  - `listAcceptedFriendshipsWithProfiles(db, userId): FriendshipWithProfiles[]`
  - `listPendingRequestsFor(db, userId): FriendshipWithInitiator[]`
  - `listFriendshipPairsFor(db, userId): { initiatorId: string; receiverId: string; status: string }[]`
  - `findFriendshipById(db, id): Friendship | null`
  - `findFriendshipBetween(db, a, b): Friendship | null`
  - `createFriendshipRequest(db, initiatorId, receiverId): FriendshipWithProfiles`
  - `acceptFriendship(db, id): FriendshipWithProfiles`
  - `deleteFriendship(db, id): void`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `backend/test/friendships.test.ts` :

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  listAcceptedFriendshipsFor, listAcceptedFriendshipsWithProfiles,
  listPendingRequestsFor, listFriendshipPairsFor, findFriendshipById,
  findFriendshipBetween, createFriendshipRequest, acceptFriendship, deleteFriendship
} from '../src/db/friendships.js';

test('a new request is pending, and findable from either side', () => {
  const db = migratedDb();
  const ada = insertUser(db, { displayName: 'Ada' });
  const bo = insertUser(db, { displayName: 'Bo' });

  const created = createFriendshipRequest(db, ada.id, bo.id);

  assert.equal(created.status, 'pending');
  assert.ok(created.id.length > 0);
  assert.equal(findFriendshipBetween(db, ada.id, bo.id)!.id, created.id);
  assert.equal(findFriendshipBetween(db, bo.id, ada.id)!.id, created.id,
    'the pair is unordered: a request in either direction is the same friendship');
  assert.equal(findFriendshipBetween(db, ada.id, 'stranger'), null);
});

test('createFriendshipRequest returns both profiles nested, as the callers destructure them', () => {
  const db = migratedDb();
  const ada = insertUser(db, { displayName: 'Ada' });
  const bo = insertUser(db, { displayName: 'Bo' });

  const created = createFriendshipRequest(db, ada.id, bo.id);

  assert.equal(created.initiator.displayName, 'Ada');
  assert.equal(created.receiver.displayName, 'Bo');
  assert.ok(created.initiator.createdAt instanceof Date);
});

test('pending requests list only those received, with the initiator attached', () => {
  const db = migratedDb();
  const ada = insertUser(db, { displayName: 'Ada' });
  const bo = insertUser(db, { displayName: 'Bo' });
  const cy = insertUser(db, { displayName: 'Cy' });

  createFriendshipRequest(db, ada.id, bo.id);   // Bo receives
  createFriendshipRequest(db, bo.id, cy.id);    // Bo sends

  const requests = listPendingRequestsFor(db, bo.id);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].initiator.displayName, 'Ada');
});

test('accepting moves the status and advances updatedAt', async () => {
  const db = migratedDb();
  const ada = insertUser(db, { displayName: 'Ada' });
  const bo = insertUser(db, { displayName: 'Bo' });
  const created = createFriendshipRequest(db, ada.id, bo.id);
  await new Promise(r => setTimeout(r, 5));

  const accepted = acceptFriendship(db, created.id);

  assert.equal(accepted.status, 'accepted');
  assert.ok(accepted.updatedAt.getTime() > created.updatedAt.getTime(),
    'the friends list shows updatedAt as "friends since"; it has to move');
  assert.equal(accepted.initiator.displayName, 'Ada');
  assert.equal(accepted.receiver.displayName, 'Bo');
});

test('accepted friendships are listed from both sides, pending ones are not', () => {
  const db = migratedDb();
  const ada = insertUser(db, { displayName: 'Ada' });
  const bo = insertUser(db, { displayName: 'Bo' });
  const cy = insertUser(db, { displayName: 'Cy' });

  const accepted = createFriendshipRequest(db, ada.id, bo.id);
  acceptFriendship(db, accepted.id);
  createFriendshipRequest(db, ada.id, cy.id); // stays pending

  assert.equal(listAcceptedFriendshipsFor(db, ada.id).length, 1);
  assert.equal(listAcceptedFriendshipsFor(db, bo.id).length, 1);
  assert.equal(listAcceptedFriendshipsFor(db, cy.id).length, 0);
});

test('the profile-carrying list gives both sides, whichever end you are', () => {
  const db = migratedDb();
  const ada = insertUser(db, { displayName: 'Ada' });
  const bo = insertUser(db, { displayName: 'Bo' });
  acceptFriendship(db, createFriendshipRequest(db, ada.id, bo.id).id);

  const [fromBo] = listAcceptedFriendshipsWithProfiles(db, bo.id);

  assert.equal(fromBo.initiator.displayName, 'Ada');
  assert.equal(fromBo.receiver.displayName, 'Bo');
  assert.equal(fromBo.initiatorId, ada.id);
});

test('listFriendshipPairsFor returns every link regardless of status', () => {
  const db = migratedDb();
  const ada = insertUser(db);
  const bo = insertUser(db);
  const cy = insertUser(db);
  acceptFriendship(db, createFriendshipRequest(db, ada.id, bo.id).id);
  createFriendshipRequest(db, ada.id, cy.id);

  const pairs = listFriendshipPairsFor(db, ada.id);

  assert.equal(pairs.length, 2, 'search filters out pending links too, so they must be here');
  assert.deepEqual(Object.keys(pairs[0]).sort(), ['initiatorId', 'receiverId', 'status']);
});

test('deleting removes the row and leaves both users standing', () => {
  const db = migratedDb();
  const ada = insertUser(db);
  const bo = insertUser(db);
  const created = createFriendshipRequest(db, ada.id, bo.id);

  deleteFriendship(db, created.id);

  assert.equal(findFriendshipById(db, created.id), null);
  const users = db.prepare(`SELECT COUNT(*) AS n FROM "User"`).get() as { n: number };
  assert.equal(users.n, 2);
});

test('deleting a user cascades their friendships away', () => {
  const db = migratedDb();
  const ada = insertUser(db);
  const bo = insertUser(db);
  createFriendshipRequest(db, ada.id, bo.id);

  db.prepare(`DELETE FROM "User" WHERE id = ?`).run(ada.id);

  const left = db.prepare(`SELECT COUNT(*) AS n FROM "Friendship"`).get() as { n: number };
  assert.equal(left.n, 0, 'onDelete: Cascade only works with foreign_keys ON');
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

```bash
node --import tsx --test backend/test/friendships.test.ts
```

Attendu : ÉCHEC — module introuvable.

- [ ] **Step 3: Écrire l'implémentation**

Créer `backend/src/db/friendships.ts` :

```ts
import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { Friendship, User } from './types.js';

export interface FriendshipWithProfiles extends Friendship {
  initiator: User;
  receiver: User;
}

export interface FriendshipWithInitiator extends Friendship {
  initiator: User;
}

interface FriendshipRow {
  id: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  initiatorId: string;
  receiverId: string;
}

function toFriendship(row: FriendshipRow): Friendship {
  return {
    id: row.id,
    status: row.status,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    initiatorId: row.initiatorId,
    receiverId: row.receiverId
  };
}

/**
 * The joins used to come back as nested objects, and the callers read them that
 * way - `f.initiator.displayName`. A flat row would mean changing every caller,
 * so the nesting is rebuilt here instead, once.
 *
 * Columns are aliased with a prefix rather than selected as `u.*`, because
 * User and Friendship both have `id`, `createdAt` and `updatedAt`.
 */
const USER_COLUMNS = (alias: string, prefix: string) => `
  ${alias}.id AS ${prefix}_id,
  ${alias}.googleId AS ${prefix}_googleId,
  ${alias}.email AS ${prefix}_email,
  ${alias}.displayName AS ${prefix}_displayName,
  ${alias}.avatar AS ${prefix}_avatar,
  ${alias}.controlsConfig AS ${prefix}_controlsConfig,
  ${alias}.createdAt AS ${prefix}_createdAt,
  ${alias}.updatedAt AS ${prefix}_updatedAt
`;

function toUserFrom(row: Record<string, unknown>, prefix: string): User {
  return {
    id: row[`${prefix}_id`] as string,
    googleId: row[`${prefix}_googleId`] as string,
    email: row[`${prefix}_email`] as string,
    displayName: row[`${prefix}_displayName`] as string,
    avatar: (row[`${prefix}_avatar`] as string | null) ?? null,
    controlsConfig: (row[`${prefix}_controlsConfig`] as string | null) ?? null,
    createdAt: new Date(row[`${prefix}_createdAt`] as number),
    updatedAt: new Date(row[`${prefix}_updatedAt`] as number)
  };
}

function toFriendshipBase(row: Record<string, unknown>): Friendship {
  return toFriendship({
    id: row.id as string,
    status: row.status as string,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    initiatorId: row.initiatorId as string,
    receiverId: row.receiverId as string
  });
}

const BOTH_PROFILES = `
  SELECT f.*,
    ${USER_COLUMNS('i', 'i')},
    ${USER_COLUMNS('r', 'r')}
  FROM "Friendship" f
  JOIN "User" i ON i.id = f.initiatorId
  JOIN "User" r ON r.id = f.receiverId
`;

function toWithProfiles(row: Record<string, unknown>): FriendshipWithProfiles {
  return {
    ...toFriendshipBase(row),
    initiator: toUserFrom(row, 'i'),
    receiver: toUserFrom(row, 'r')
  };
}

export function listAcceptedFriendshipsFor(db: Database, userId: string): Friendship[] {
  const rows = db.prepare(`
    SELECT * FROM "Friendship"
    WHERE (initiatorId = ? OR receiverId = ?) AND status = 'accepted'
  `).all(userId, userId) as FriendshipRow[];
  return rows.map(toFriendship);
}

export function listAcceptedFriendshipsWithProfiles(
  db: Database,
  userId: string
): FriendshipWithProfiles[] {
  const rows = db.prepare(`
    ${BOTH_PROFILES}
    WHERE (f.initiatorId = ? OR f.receiverId = ?) AND f.status = 'accepted'
  `).all(userId, userId) as Record<string, unknown>[];
  return rows.map(toWithProfiles);
}

export function listPendingRequestsFor(db: Database, userId: string): FriendshipWithInitiator[] {
  const rows = db.prepare(`
    SELECT f.*, ${USER_COLUMNS('i', 'i')}
    FROM "Friendship" f
    JOIN "User" i ON i.id = f.initiatorId
    WHERE f.receiverId = ? AND f.status = 'pending'
  `).all(userId) as Record<string, unknown>[];
  return rows.map(row => ({ ...toFriendshipBase(row), initiator: toUserFrom(row, 'i') }));
}

export function listFriendshipPairsFor(
  db: Database,
  userId: string
): { initiatorId: string; receiverId: string; status: string }[] {
  return db.prepare(`
    SELECT initiatorId, receiverId, status FROM "Friendship"
    WHERE initiatorId = ? OR receiverId = ?
  `).all(userId, userId) as { initiatorId: string; receiverId: string; status: string }[];
}

export function findFriendshipById(db: Database, id: string): Friendship | null {
  const row = db.prepare(`SELECT * FROM "Friendship" WHERE id = ?`).get(id) as FriendshipRow | undefined;
  return row ? toFriendship(row) : null;
}

export function findFriendshipBetween(db: Database, a: string, b: string): Friendship | null {
  const row = db.prepare(`
    SELECT * FROM "Friendship"
    WHERE (initiatorId = ? AND receiverId = ?) OR (initiatorId = ? AND receiverId = ?)
  `).get(a, b, b, a) as FriendshipRow | undefined;
  return row ? toFriendship(row) : null;
}

function findWithProfiles(db: Database, id: string): FriendshipWithProfiles {
  const row = db.prepare(`${BOTH_PROFILES} WHERE f.id = ?`).get(id) as Record<string, unknown>;
  return toWithProfiles(row);
}

export function createFriendshipRequest(
  db: Database,
  initiatorId: string,
  receiverId: string
): FriendshipWithProfiles {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO "Friendship" (id, status, createdAt, updatedAt, initiatorId, receiverId)
    VALUES (?, 'pending', ?, ?, ?, ?)
  `).run(id, now, now, initiatorId, receiverId);
  return findWithProfiles(db, id);
}

export function acceptFriendship(db: Database, id: string): FriendshipWithProfiles {
  db.prepare(`UPDATE "Friendship" SET status = 'accepted', updatedAt = ? WHERE id = ?`)
    .run(Date.now(), id);
  return findWithProfiles(db, id);
}

export function deleteFriendship(db: Database, id: string): void {
  db.prepare(`DELETE FROM "Friendship" WHERE id = ?`).run(id);
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

```bash
node --import tsx --test backend/test/friendships.test.ts
```

Attendu : 9 tests passants.

- [ ] **Step 5: Commit (demander l'accord d'abord)**

```bash
git add backend/src/db/friendships.ts backend/test/friendships.test.ts
git commit -m "Rebuild the friendship joins the callers already destructure"
```

### Task 10: Le dépôt des jeux

**Files:**
- Create: `backend/src/db/games.ts`
- Create: `backend/test/games.test.ts`

**Interfaces:**
- Consumes: `Database`, `Game`, `SaveSummary`, `Save`
- Produces:
  - `interface GameWithSaveSummaries extends Game { saves: SaveSummary[] }`
  - `interface GameWithSaves extends Game { saves: Save[] }`
  - `interface GameDescriptiveFields { genre: string | null; publisher: string | null; developer: string | null; releaseDate: string | null; players: string | null; region: string | null; description: string | null; coverUrl: string | null }`
  - `interface GameMetadataFields extends GameDescriptiveFields { title: string }`
  - `listGamesWithSaveSummaries(db, userId): GameWithSaveSummaries[]`
  - `listGamesFor(db, userId): Game[]`
  - `findGameById(db, id): Game | null`
  - `findGameWithSaves(db, id): GameWithSaves | null`
  - `findGameByChecksum(db, userId, crc32): Game | null`
  - `findOtherGameWithChecksum(db, userId, crc32, excludeGameId): Game | null`
  - `countGamesFor(db, userId): number`
  - `createGame(db, input: { title: string; filename: string; crc32: string | null; userId: string } & GameDescriptiveFields): Game`
  - `updateGameChecksum(db, id, crc32): Game`
  - `updateGameMetadata(db, id, fields: GameMetadataFields): void`
  - `deleteGame(db, id): void`
  - `findOwnedGameId(db, gameId, userId): string | null`
  - `findChecksumOfOwnedGame(db, gameId, userId): string | null`
  - `saveSram(db, gameId, userId, sram: Buffer): void`
  - `findSram(db, gameId, userId): { sram: Buffer; sramUpdatedAt: Date | null } | null`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `backend/test/games.test.ts` :

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import {
  listGamesWithSaveSummaries, listGamesFor, findGameById, findGameWithSaves,
  findGameByChecksum, findOtherGameWithChecksum, countGamesFor, createGame,
  updateGameChecksum, updateGameMetadata, deleteGame, findOwnedGameId,
  findChecksumOfOwnedGame, saveSram, findSram
} from '../src/db/games.js';
import { createSave } from '../src/db/saves.js';

const NO_METADATA = {
  genre: null, publisher: null, developer: null, releaseDate: null,
  players: null, region: null, description: null, coverUrl: null
};

test('createGame stamps an id and uploadedAt, and defaults the rest to null', () => {
  const db = migratedDb();
  const user = insertUser(db);

  const game = createGame(db, {
    title: 'Super Metroid', filename: 'sm.sfc', crc32: 'DEADBEEF',
    userId: user.id, ...NO_METADATA
  });

  assert.ok(game.id.length > 0);
  assert.ok(game.uploadedAt instanceof Date);
  assert.equal(game.sram, null);
  assert.equal(game.sramUpdatedAt, null);
  assert.equal(game.genre, null);
});

test('a library lists newest first, with save summaries but never save blobs', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const older = createGame(db, { title: 'A', filename: 'a.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });
  const newer = createGame(db, { title: 'B', filename: 'b.sfc', crc32: 'BBBBBBBB', userId: user.id, ...NO_METADATA });
  db.prepare(`UPDATE "Game" SET uploadedAt = ? WHERE id = ?`).run(1_000, older.id);
  db.prepare(`UPDATE "Game" SET uploadedAt = ? WHERE id = ?`).run(2_000, newer.id);
  createSave(db, { gameId: newer.id, slotNumber: 1, name: 'slot one', data: Buffer.from([1, 2, 3]), screenshot: null });

  const library = listGamesWithSaveSummaries(db, user.id);

  assert.deepEqual(library.map(g => g.title), ['B', 'A']);
  assert.equal(library[0].saves.length, 1);
  assert.equal(library[0].saves[0].name, 'slot one');
  assert.ok(!('data' in library[0].saves[0]), 'a library listing must not carry savestate blobs');
  assert.ok(library[0].saves[0].createdAt instanceof Date);
  assert.deepEqual(library[1].saves, []);
});

test('a library shows only the caller games', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const theirs = insertUser(db);
  createGame(db, { title: 'Mine', filename: 'm.sfc', crc32: 'AAAAAAAA', userId: mine.id, ...NO_METADATA });
  createGame(db, { title: 'Theirs', filename: 't.sfc', crc32: 'BBBBBBBB', userId: theirs.id, ...NO_METADATA });

  assert.equal(listGamesWithSaveSummaries(db, mine.id).length, 1);
  assert.equal(listGamesFor(db, mine.id).length, 1);
  assert.equal(countGamesFor(db, mine.id), 1);
});

test('a checksum finds a game within its owner library only', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const theirs = insertUser(db);
  createGame(db, { title: 'Mine', filename: 'm.sfc', crc32: 'DEADBEEF', userId: mine.id, ...NO_METADATA });

  assert.ok(findGameByChecksum(db, mine.id, 'DEADBEEF'));
  assert.equal(findGameByChecksum(db, theirs.id, 'DEADBEEF'), null);
});

test('re-linking a checksum detects a clash with another of your games', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const first = createGame(db, { title: 'First', filename: 'f.sfc', crc32: 'DEADBEEF', userId: user.id, ...NO_METADATA });
  const second = createGame(db, { title: 'Second', filename: 's.sfc', crc32: null, userId: user.id, ...NO_METADATA });

  assert.equal(findOtherGameWithChecksum(db, user.id, 'DEADBEEF', second.id)!.id, first.id);
  assert.equal(findOtherGameWithChecksum(db, user.id, 'DEADBEEF', first.id), null,
    'a game never clashes with itself');

  const updated = updateGameChecksum(db, second.id, 'CAFEBABE');
  assert.equal(updated.crc32, 'CAFEBABE');
});

test('metadata refresh overwrites the descriptive fields', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, { title: 'Rough Name', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });

  updateGameMetadata(db, game.id, {
    title: 'Proper Name', genre: 'Action', publisher: 'Nintendo', developer: 'Nintendo R&D1',
    releaseDate: '1994-03-19', players: '1', region: 'NTSC', description: 'A game', coverUrl: 'c.png'
  });

  const read = findGameById(db, game.id)!;
  assert.equal(read.title, 'Proper Name');
  assert.equal(read.genre, 'Action');
  assert.equal(read.coverUrl, 'c.png');
});

test('deleting a game takes its saves with it', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, { title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });
  createSave(db, { gameId: game.id, slotNumber: 1, name: 's', data: Buffer.from([1]), screenshot: null });

  deleteGame(db, game.id);

  assert.equal(findGameById(db, game.id), null);
  const saves = db.prepare(`SELECT COUNT(*) AS n FROM "Save"`).get() as { n: number };
  assert.equal(saves.n, 0, 'the server never held the ROM, but the saves must go');
});

test('findGameWithSaves nests the full saves, blobs included', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, { title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });
  createSave(db, { gameId: game.id, slotNumber: 2, name: 's', data: Buffer.from([9, 8, 7]), screenshot: null });

  const found = findGameWithSaves(db, game.id)!;

  assert.equal(found.saves.length, 1);
  assert.ok(Buffer.isBuffer(found.saves[0].data));
  assert.deepEqual([...found.saves[0].data], [9, 8, 7]);
});

test('ownership checks refuse a game that is not yours', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const theirs = insertUser(db);
  const game = createGame(db, { title: 'G', filename: 'g.sfc', crc32: 'DEADBEEF', userId: mine.id, ...NO_METADATA });

  assert.equal(findOwnedGameId(db, game.id, mine.id), game.id);
  assert.equal(findOwnedGameId(db, game.id, theirs.id), null);
  assert.equal(findChecksumOfOwnedGame(db, game.id, mine.id), 'DEADBEEF');
  assert.equal(findChecksumOfOwnedGame(db, game.id, theirs.id), null);
});

test('SRAM round-trips as a Buffer and stamps its own timestamp', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, { title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });

  assert.equal(findSram(db, game.id, user.id), null, 'no SRAM yet');

  const bytes = Buffer.alloc(8192, 0x5a);
  saveSram(db, game.id, user.id, bytes);

  const read = findSram(db, game.id, user.id)!;
  assert.ok(Buffer.isBuffer(read.sram));
  assert.equal(read.sram.length, 8192);
  assert.equal(read.sram[0], 0x5a);
  assert.ok(read.sramUpdatedAt instanceof Date);
});

test('SRAM writes refuse a game that is not yours', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const theirs = insertUser(db);
  const game = createGame(db, { title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: mine.id, ...NO_METADATA });

  saveSram(db, game.id, theirs.id, Buffer.from([1, 2, 3]));

  assert.equal(findSram(db, game.id, mine.id), null, 'the write must not have landed');
});

test('a large savestate blob survives the round trip intact', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = createGame(db, { title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId: user.id, ...NO_METADATA });
  // Savestates run around 823KB; check the real order of magnitude, not a toy.
  const big = Buffer.alloc(900_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 256;
  createSave(db, { gameId: game.id, slotNumber: 1, name: 'big', data: big, screenshot: null });

  const read = findGameWithSaves(db, game.id)!.saves[0];

  assert.equal(read.data.length, big.length);
  assert.ok(read.data.equals(big), 'the blob must come back byte for byte');
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

```bash
node --import tsx --test backend/test/games.test.ts
```

Attendu : ÉCHEC — `backend/src/db/games.js` et `backend/src/db/saves.js` introuvables. La Task 11 écrit le second ; l'implémenter d'abord si l'on préfère un rouge plus net, ou accepter que ce fichier de test ne devienne vert qu'à la fin de la Task 11.

- [ ] **Step 3: Écrire l'implémentation**

Créer `backend/src/db/games.ts` :

```ts
import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { Game, Save, SaveSummary } from './types.js';

export interface GameWithSaveSummaries extends Game {
  saves: SaveSummary[];
}

export interface GameWithSaves extends Game {
  saves: Save[];
}

/** The descriptive columns, which a metadata match fills in and a bare add leaves null. */
export interface GameDescriptiveFields {
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  coverUrl: string | null;
}

/** A metadata refresh also rewrites the title, which creation takes separately. */
export interface GameMetadataFields extends GameDescriptiveFields {
  title: string;
}

interface GameRow {
  id: string;
  title: string;
  filename: string;
  coverUrl: string | null;
  uploadedAt: number;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  crc32: string | null;
  sram: Buffer | null;
  sramUpdatedAt: number | null;
  userId: string;
}

function toGame(row: GameRow): Game {
  return {
    id: row.id,
    title: row.title,
    filename: row.filename,
    coverUrl: row.coverUrl,
    uploadedAt: new Date(row.uploadedAt),
    genre: row.genre,
    publisher: row.publisher,
    developer: row.developer,
    releaseDate: row.releaseDate,
    players: row.players,
    region: row.region,
    description: row.description,
    crc32: row.crc32,
    sram: row.sram,
    sramUpdatedAt: row.sramUpdatedAt === null ? null : new Date(row.sramUpdatedAt),
    userId: row.userId
  };
}

export function findGameById(db: Database, id: string): Game | null {
  const row = db.prepare(`SELECT * FROM "Game" WHERE id = ?`).get(id) as GameRow | undefined;
  return row ? toGame(row) : null;
}

export function listGamesFor(db: Database, userId: string): Game[] {
  const rows = db.prepare(`SELECT * FROM "Game" WHERE userId = ?`).all(userId) as GameRow[];
  return rows.map(toGame);
}

/**
 * The library listing. Saves come back as summaries: the blob is up to a
 * megabyte per slot and the listing never used it.
 */
export function listGamesWithSaveSummaries(db: Database, userId: string): GameWithSaveSummaries[] {
  const games = db.prepare(`SELECT * FROM "Game" WHERE userId = ? ORDER BY uploadedAt DESC`)
    .all(userId) as GameRow[];
  if (games.length === 0) return [];

  const summaries = db.prepare(`
    SELECT id, name, slotNumber, screenshot, createdAt, updatedAt, gameId
    FROM "Save" WHERE gameId IN (${games.map(() => '?').join(',')})
  `).all(...games.map(g => g.id)) as (Omit<SaveSummary, 'createdAt' | 'updatedAt'> & {
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

  return games.map(g => ({ ...toGame(g), saves: byGame.get(g.id) ?? [] }));
}

export function findGameWithSaves(db: Database, id: string): GameWithSaves | null {
  const game = findGameById(db, id);
  if (!game) return null;
  const rows = db.prepare(`SELECT * FROM "Save" WHERE gameId = ?`).all(id) as {
    id: string; name: string; slotNumber: number; data: Buffer; screenshot: string | null;
    createdAt: number; updatedAt: number; gameId: string;
  }[];
  return {
    ...game,
    saves: rows.map(r => ({
      id: r.id,
      name: r.name,
      slotNumber: r.slotNumber,
      data: r.data,
      screenshot: r.screenshot,
      createdAt: new Date(r.createdAt),
      updatedAt: new Date(r.updatedAt),
      gameId: r.gameId
    }))
  };
}

export function findGameByChecksum(db: Database, userId: string, crc32: string): Game | null {
  const row = db.prepare(`SELECT * FROM "Game" WHERE userId = ? AND crc32 = ?`)
    .get(userId, crc32) as GameRow | undefined;
  return row ? toGame(row) : null;
}

export function findOtherGameWithChecksum(
  db: Database, userId: string, crc32: string, excludeGameId: string
): Game | null {
  const row = db.prepare(`SELECT * FROM "Game" WHERE userId = ? AND crc32 = ? AND id != ?`)
    .get(userId, crc32, excludeGameId) as GameRow | undefined;
  return row ? toGame(row) : null;
}

export function countGamesFor(db: Database, userId: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "Game" WHERE userId = ?`)
    .get(userId) as { n: number };
  return row.n;
}

export function createGame(
  db: Database,
  input: { title: string; filename: string; crc32: string | null; userId: string } & GameDescriptiveFields
): Game {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO "Game" (id, title, filename, coverUrl, uploadedAt, genre, publisher,
                        developer, releaseDate, players, region, description, crc32,
                        sram, sramUpdatedAt, userId)
    VALUES (@id, @title, @filename, @coverUrl, @uploadedAt, @genre, @publisher,
            @developer, @releaseDate, @players, @region, @description, @crc32,
            NULL, NULL, @userId)
  `).run({
    id,
    title: input.title,
    filename: input.filename,
    coverUrl: input.coverUrl,
    uploadedAt: Date.now(),
    genre: input.genre,
    publisher: input.publisher,
    developer: input.developer,
    releaseDate: input.releaseDate,
    players: input.players,
    region: input.region,
    description: input.description,
    crc32: input.crc32,
    userId: input.userId
  });
  return findGameById(db, id)!;
}

export function updateGameChecksum(db: Database, id: string, crc32: string): Game {
  db.prepare(`UPDATE "Game" SET crc32 = ? WHERE id = ?`).run(crc32, id);
  return findGameById(db, id)!;
}

export function updateGameMetadata(db: Database, id: string, fields: GameMetadataFields): void {
  db.prepare(`
    UPDATE "Game" SET
      title = @title, genre = @genre, publisher = @publisher,
      developer = @developer, releaseDate = @releaseDate, players = @players,
      region = @region, description = @description, coverUrl = @coverUrl
    WHERE id = @id
  `).run({
    id,
    title: fields.title,
    genre: fields.genre,
    publisher: fields.publisher,
    developer: fields.developer,
    releaseDate: fields.releaseDate,
    players: fields.players,
    region: fields.region,
    description: fields.description,
    coverUrl: fields.coverUrl
  });
}

export function deleteGame(db: Database, id: string): void {
  db.prepare(`DELETE FROM "Game" WHERE id = ?`).run(id);
}

/** Ownership check for the save path: returns the id only if the game is theirs. */
export function findOwnedGameId(db: Database, gameId: string, userId: string): string | null {
  const row = db.prepare(`SELECT id FROM "Game" WHERE id = ? AND userId = ?`)
    .get(gameId, userId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function findChecksumOfOwnedGame(db: Database, gameId: string, userId: string): string | null {
  const row = db.prepare(`SELECT crc32 FROM "Game" WHERE id = ? AND userId = ?`)
    .get(gameId, userId) as { crc32: string | null } | undefined;
  return row?.crc32 ?? null;
}

export function saveSram(db: Database, gameId: string, userId: string, sram: Buffer): void {
  db.prepare(`UPDATE "Game" SET sram = ?, sramUpdatedAt = ? WHERE id = ? AND userId = ?`)
    .run(sram, Date.now(), gameId, userId);
}

export function findSram(
  db: Database, gameId: string, userId: string
): { sram: Buffer; sramUpdatedAt: Date | null } | null {
  const row = db.prepare(`SELECT sram, sramUpdatedAt FROM "Game" WHERE id = ? AND userId = ?`)
    .get(gameId, userId) as { sram: Buffer | null; sramUpdatedAt: number | null } | undefined;
  if (!row?.sram) return null;
  return {
    sram: row.sram,
    sramUpdatedAt: row.sramUpdatedAt === null ? null : new Date(row.sramUpdatedAt)
  };
}
```

**Note sur les deux types de champs.** `createGame` prend `GameDescriptiveFields` (sans titre : la création reçoit son titre à part, parce qu'il peut venir du nom de fichier plutôt que des métadonnées), tandis que `updateGameMetadata` prend `GameMetadataFields`, qui ajoute le titre — un rafraîchissement de métadonnées réécrit bien le titre, c'est son intérêt principal. Les paramètres sont énumérés un par un dans les deux fonctions plutôt que passés par spread : un champ oublié devient alors une erreur de compilation au lieu d'une colonne laissée à sa valeur par défaut.

- [ ] **Step 4: Lancer les tests pour les voir passer**

```bash
node --import tsx --test backend/test/games.test.ts backend/test/saves.test.ts
```

Attendu : tous verts une fois la Task 11 faite. Le test du blob de 900 Ko est celui qui compte le plus : c'est la seule vérification que les savestates réels survivent au changement de driver.

- [ ] **Step 5: Commit (demander l'accord d'abord)**

```bash
git add backend/src/db/games.ts backend/test/games.test.ts
git commit -m "Give games a repository, and prove a 900KB savestate survives"
```

### Task 11: Le dépôt des sauvegardes

**Files:**
- Create: `backend/src/db/saves.ts`
- Create: `backend/test/saves.test.ts`

**Interfaces:**
- Consumes: `Database`, `Save`, `Game`
- Produces:
  - `interface SaveWithGame extends Save { game: Game }`
  - `findSaveInSlot(db, gameId, slotNumber, ownerId): Save | null`
  - `findSaveWithGame(db, id): SaveWithGame | null`
  - `createSave(db, input: { gameId: string; slotNumber: number; name: string; data: Buffer; screenshot: string | null }): Save`
  - `updateSaveData(db, id, name: string, data: Buffer): void`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `backend/test/saves.test.ts` :

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb, insertUser } from './helpers.js';
import { createGame } from '../src/db/games.js';
import { findSaveInSlot, findSaveWithGame, createSave, updateSaveData } from '../src/db/saves.js';

const NO_METADATA = {
  genre: null, publisher: null, developer: null, releaseDate: null,
  players: null, region: null, description: null, coverUrl: null
};

function aGame(db: ReturnType<typeof migratedDb>, userId: string) {
  return createGame(db, {
    title: 'G', filename: 'g.sfc', crc32: 'AAAAAAAA', userId, ...NO_METADATA
  });
}

test('createSave stamps id and both timestamps, and keeps the blob', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);

  const save = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'first', data: Buffer.from([1, 2, 3]), screenshot: null
  });

  assert.ok(save.id.length > 0);
  assert.ok(save.createdAt instanceof Date);
  assert.ok(save.updatedAt instanceof Date);
  assert.ok(Buffer.isBuffer(save.data));
  assert.deepEqual([...save.data], [1, 2, 3]);
});

test('findSaveInSlot only finds a slot in a game the caller owns', () => {
  const db = migratedDb();
  const mine = insertUser(db);
  const theirs = insertUser(db);
  const game = aGame(db, mine.id);
  createSave(db, { gameId: game.id, slotNumber: 3, name: 's', data: Buffer.from([1]), screenshot: null });

  assert.ok(findSaveInSlot(db, game.id, 3, mine.id));
  assert.equal(findSaveInSlot(db, game.id, 3, theirs.id), null,
    'a guest in the room must not reach the host slots');
  assert.equal(findSaveInSlot(db, game.id, 9, mine.id), null);
});

test('updateSaveData replaces the blob and advances updatedAt', async () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);
  const save = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 'first', data: Buffer.from([1]), screenshot: null
  });
  await new Promise(r => setTimeout(r, 5));

  updateSaveData(db, save.id, 'renamed', Buffer.from([7, 7, 7]));

  const read = findSaveInSlot(db, game.id, 1, user.id)!;
  assert.equal(read.name, 'renamed');
  assert.deepEqual([...read.data], [7, 7, 7]);
  assert.ok(read.updatedAt.getTime() > save.updatedAt.getTime());
});

test('findSaveWithGame nests the owning game, so the caller can check ownership', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);
  const save = createSave(db, {
    gameId: game.id, slotNumber: 1, name: 's', data: Buffer.from([1]), screenshot: null
  });

  const found = findSaveWithGame(db, save.id)!;

  assert.equal(found.game.id, game.id);
  assert.equal(found.game.userId, user.id);
  assert.ok(found.game.uploadedAt instanceof Date);
  assert.ok(Buffer.isBuffer(found.data));
});

test('findSaveWithGame returns null for an unknown save', () => {
  const db = migratedDb();
  assert.equal(findSaveWithGame(db, 'nope'), null);
});

test('one slot per game is enforced by the schema', () => {
  const db = migratedDb();
  const user = insertUser(db);
  const game = aGame(db, user.id);
  createSave(db, { gameId: game.id, slotNumber: 1, name: 'a', data: Buffer.from([1]), screenshot: null });

  assert.throws(
    () => createSave(db, { gameId: game.id, slotNumber: 1, name: 'b', data: Buffer.from([2]), screenshot: null }),
    /UNIQUE/,
    'the unique index on (gameId, slotNumber) is why the handler checks before inserting'
  );
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

```bash
node --import tsx --test backend/test/saves.test.ts
```

Attendu : ÉCHEC — module introuvable.

- [ ] **Step 3: Écrire l'implémentation**

Créer `backend/src/db/saves.ts` :

```ts
import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { Game, Save } from './types.js';

export interface SaveWithGame extends Save {
  game: Game;
}

interface SaveRow {
  id: string;
  name: string;
  slotNumber: number;
  data: Buffer;
  screenshot: string | null;
  createdAt: number;
  updatedAt: number;
  gameId: string;
}

function toSave(row: SaveRow): Save {
  return {
    id: row.id,
    name: row.name,
    slotNumber: row.slotNumber,
    data: row.data,
    screenshot: row.screenshot,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    gameId: row.gameId
  };
}

/**
 * Finds a slot, but only inside a game the caller owns.
 *
 * The ownership test is part of the query rather than a check afterwards: a
 * guest sitting in someone else room must never reach the host slots, and a
 * filter that lives in the SQL cannot be forgotten by a caller.
 */
export function findSaveInSlot(
  db: Database, gameId: string, slotNumber: number, ownerId: string
): Save | null {
  const row = db.prepare(`
    SELECT s.* FROM "Save" s
    JOIN "Game" g ON g.id = s.gameId
    WHERE s.gameId = ? AND s.slotNumber = ? AND g.userId = ?
  `).get(gameId, slotNumber, ownerId) as SaveRow | undefined;
  return row ? toSave(row) : null;
}

export function findSaveWithGame(db: Database, id: string): SaveWithGame | null {
  const row = db.prepare(`
    SELECT s.*,
      g.id AS g_id, g.title AS g_title, g.filename AS g_filename, g.coverUrl AS g_coverUrl,
      g.uploadedAt AS g_uploadedAt, g.genre AS g_genre, g.publisher AS g_publisher,
      g.developer AS g_developer, g.releaseDate AS g_releaseDate, g.players AS g_players,
      g.region AS g_region, g.description AS g_description, g.crc32 AS g_crc32,
      g.sram AS g_sram, g.sramUpdatedAt AS g_sramUpdatedAt, g.userId AS g_userId
    FROM "Save" s
    JOIN "Game" g ON g.id = s.gameId
    WHERE s.id = ?
  `).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const game: Game = {
    id: row.g_id as string,
    title: row.g_title as string,
    filename: row.g_filename as string,
    coverUrl: (row.g_coverUrl as string | null) ?? null,
    uploadedAt: new Date(row.g_uploadedAt as number),
    genre: (row.g_genre as string | null) ?? null,
    publisher: (row.g_publisher as string | null) ?? null,
    developer: (row.g_developer as string | null) ?? null,
    releaseDate: (row.g_releaseDate as string | null) ?? null,
    players: (row.g_players as string | null) ?? null,
    region: (row.g_region as string | null) ?? null,
    description: (row.g_description as string | null) ?? null,
    crc32: (row.g_crc32 as string | null) ?? null,
    sram: (row.g_sram as Buffer | null) ?? null,
    sramUpdatedAt: row.g_sramUpdatedAt === null ? null : new Date(row.g_sramUpdatedAt as number),
    userId: row.g_userId as string
  };

  return {
    ...toSave({
      id: row.id as string,
      name: row.name as string,
      slotNumber: row.slotNumber as number,
      data: row.data as Buffer,
      screenshot: (row.screenshot as string | null) ?? null,
      createdAt: row.createdAt as number,
      updatedAt: row.updatedAt as number,
      gameId: row.gameId as string
    }),
    game
  };
}

export function createSave(
  db: Database,
  input: { gameId: string; slotNumber: number; name: string; data: Buffer; screenshot: string | null }
): Save {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO "Save" (id, name, slotNumber, data, screenshot, createdAt, updatedAt, gameId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.name, input.slotNumber, input.data, input.screenshot, now, now, input.gameId);

  const row = db.prepare(`SELECT * FROM "Save" WHERE id = ?`).get(id) as SaveRow;
  return toSave(row);
}

export function updateSaveData(db: Database, id: string, name: string, data: Buffer): void {
  db.prepare(`UPDATE "Save" SET name = ?, data = ?, updatedAt = ? WHERE id = ?`)
    .run(name, data, Date.now(), id);
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

```bash
node --import tsx --test backend/test/saves.test.ts backend/test/games.test.ts
```

Attendu : les deux suites vertes.

- [ ] **Step 5: Commit (demander l'accord d'abord)**

```bash
git add backend/src/db/saves.ts backend/test/saves.test.ts
git commit -m "Put the save ownership check inside the query"
```

### Task 12: Le dépôt des métadonnées

**Files:**
- Create: `backend/src/db/game-metadata.ts`
- Create: `backend/test/game-metadata.test.ts`

**Interfaces:**
- Consumes: `Database`, `GameMetadata`
- Produces:
  - `countGameMetadata(db): number`
  - `createGameMetadata(db, entry): void`
  - `listGameMetadata(db): GameMetadata[]`
  - `findGameMetadataByChecksum(db, checksum): GameMetadata | null`
  - `deleteAllGameMetadata(db): void`
  - `insertGameMetadataBatch(db, entries): number`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `backend/test/game-metadata.test.ts` :

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migratedDb } from './helpers.js';
import {
  countGameMetadata, createGameMetadata, listGameMetadata,
  findGameMetadataByChecksum, deleteAllGameMetadata, insertGameMetadataBatch
} from '../src/db/game-metadata.js';

const ENTRY = {
  title: 'Super Metroid', altTitle: null, genre: 'Action', publisher: 'Nintendo',
  developer: 'Nintendo R&D1', releaseDate: '1994-03-19', players: '1',
  region: 'NTSC', description: 'A game', coverUrl: 'sm.png',
  crc32: 'D63ED5F8', md5: 'abc123'
};

test('an empty catalogue counts zero', () => {
  const db = migratedDb();
  assert.equal(countGameMetadata(db), 0);
});

test('a created entry is counted, listed and found by checksum', () => {
  const db = migratedDb();
  createGameMetadata(db, ENTRY);

  assert.equal(countGameMetadata(db), 1);

  const [listed] = listGameMetadata(db);
  assert.equal(listed.title, 'Super Metroid');
  assert.ok(listed.createdAt instanceof Date);

  assert.equal(findGameMetadataByChecksum(db, 'D63ED5F8')!.title, 'Super Metroid');
  assert.equal(findGameMetadataByChecksum(db, 'abc123')!.title, 'Super Metroid',
    'the lookup accepts a CRC32 or an MD5, as it always did');
  assert.equal(findGameMetadataByChecksum(db, 'nothing'), null);
});

test('optional fields survive as null rather than undefined', () => {
  const db = migratedDb();
  createGameMetadata(db, { ...ENTRY, altTitle: null, coverUrl: null, md5: null });

  const [listed] = listGameMetadata(db);
  assert.equal(listed.altTitle, null);
  assert.equal(listed.coverUrl, null);
  assert.equal(listed.md5, null);
});

test('the batch insert loads a whole catalogue at once', () => {
  const db = migratedDb();
  const entries = Array.from({ length: 200 }, (_, i) => ({
    ...ENTRY, title: `Game ${i}`, crc32: `CRC${i}`, md5: `MD5${i}`
  }));

  const inserted = insertGameMetadataBatch(db, entries);

  assert.equal(inserted, 200);
  assert.equal(countGameMetadata(db), 200);
});

test('refreshing clears the catalogue', () => {
  const db = migratedDb();
  createGameMetadata(db, ENTRY);

  deleteAllGameMetadata(db);

  assert.equal(countGameMetadata(db), 0);
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

```bash
node --import tsx --test backend/test/game-metadata.test.ts
```

Attendu : ÉCHEC — module introuvable.

- [ ] **Step 3: Écrire l'implémentation**

Créer `backend/src/db/game-metadata.ts` :

```ts
import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.js';
import type { GameMetadata } from './types.js';

export interface GameMetadataInput {
  title: string;
  altTitle: string | null;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  coverUrl: string | null;
  crc32: string | null;
  md5: string | null;
}

interface MetadataRow extends Omit<GameMetadata, 'createdAt' | 'updatedAt'> {
  createdAt: number;
  updatedAt: number;
}

function toMetadata(row: MetadataRow): GameMetadata {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt)
  };
}

const INSERT = `
  INSERT INTO "GameMetadata" (id, title, altTitle, genre, publisher, developer,
                              releaseDate, players, region, description, coverUrl,
                              crc32, md5, createdAt, updatedAt)
  VALUES (@id, @title, @altTitle, @genre, @publisher, @developer,
          @releaseDate, @players, @region, @description, @coverUrl,
          @crc32, @md5, @now, @now)
`;

/** `undefined` binds as an error in better-sqlite3; the JSON catalogue is full of holes. */
function normalise(entry: GameMetadataInput): GameMetadataInput {
  return {
    title: entry.title,
    altTitle: entry.altTitle ?? null,
    genre: entry.genre ?? null,
    publisher: entry.publisher ?? null,
    developer: entry.developer ?? null,
    releaseDate: entry.releaseDate ?? null,
    players: entry.players ?? null,
    region: entry.region ?? null,
    description: entry.description ?? null,
    coverUrl: entry.coverUrl ?? null,
    crc32: entry.crc32 ?? null,
    md5: entry.md5 ?? null
  };
}

export function countGameMetadata(db: Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "GameMetadata"`).get() as { n: number };
  return row.n;
}

export function createGameMetadata(db: Database, entry: GameMetadataInput): void {
  db.prepare(INSERT).run({ id: randomUUID(), now: Date.now(), ...normalise(entry) });
}

/**
 * Loads the whole catalogue in one transaction.
 *
 * The old loader inserted several thousand rows one statement at a time, each
 * its own implicit transaction. One transaction turns that from thousands of
 * fsyncs into one.
 */
export function insertGameMetadataBatch(db: Database, entries: GameMetadataInput[]): number {
  const statement = db.prepare(INSERT);
  const now = Date.now();
  const run = db.transaction((rows: GameMetadataInput[]) => {
    for (const entry of rows) {
      statement.run({ id: randomUUID(), now, ...normalise(entry) });
    }
    return rows.length;
  });
  return run(entries);
}

export function listGameMetadata(db: Database): GameMetadata[] {
  const rows = db.prepare(`SELECT * FROM "GameMetadata"`).all() as MetadataRow[];
  return rows.map(toMetadata);
}

export function findGameMetadataByChecksum(db: Database, checksum: string): GameMetadata | null {
  const row = db.prepare(`SELECT * FROM "GameMetadata" WHERE crc32 = ? OR md5 = ?`)
    .get(checksum, checksum) as MetadataRow | undefined;
  return row ? toMetadata(row) : null;
}

export function deleteAllGameMetadata(db: Database): void {
  db.prepare(`DELETE FROM "GameMetadata"`).run();
}
```

- [ ] **Step 4: Lancer les tests pour les voir passer**

```bash
node --import tsx --test backend/test/game-metadata.test.ts
```

Attendu : 5 tests passants.

- [ ] **Step 5: Commit (demander l'accord d'abord)**

```bash
git add backend/src/db/game-metadata.ts backend/test/game-metadata.test.ts
git commit -m "Load the metadata catalogue in one transaction, not thousands"
```

### Task 13: Basculer les appelants d'authentification et de profil

**Files:**
- Modify: `backend/src/auth/passport.ts:3,26,43,52,76`
- Modify: `backend/src/api/auth.ts:4,66`
- Modify: `backend/src/api/user.ts:3,17,46,64`
- Modify: `backend/src/services/user-config.ts:2,18`
- Modify: `backend/src/websocket/index.ts:3,83`
- Modify: `backend/src/types/index.ts:1-3`

**Interfaces:**
- Consumes: tout `backend/src/db/users.ts`, `getDb` de `sqlite.ts`
- Produces: `User` exporté depuis `backend/src/types/index.ts` sans passer par Prisma

- [ ] **Step 1: Couper le type `User` de Prisma**

Dans `backend/src/types/index.ts`, remplacer les trois premières lignes :

```ts
import { User as PrismaUser } from '@prisma/client';

export interface User extends PrismaUser {}
```

par :

```ts
export type { User } from '../db/types.js';
```

- [ ] **Step 2: Basculer `passport.ts`**

Remplacer `import { prisma } from '../db/prisma.js';` par :

```ts
import { getDb } from '../db/sqlite.js';
import { findUserByGoogleId, findUserById, createUser, updateUserProfile } from '../db/users.js';
```

Puis, dans le callback de la stratégie Google, remplacer le bloc `findUnique` / `create` / `update` (lignes 26 à 59) par :

```ts
            const db = getDb();
            let user = findUserByGoogleId(db, profile.id);

            // Download avatar from Google if available
            let avatarUrl = null;
            const googleAvatarUrl = profile.photos?.[0]?.value;
            if (googleAvatarUrl) {
              const downloadedAvatar = await downloadAvatar(googleAvatarUrl, profile.id);
              avatarUrl = downloadedAvatar || googleAvatarUrl; // Fallback to Google URL if download fails
            }

            // The OAuth tokens are deliberately not kept. They existed to call
            // Drive on the player's behalf; with ROMs staying on their machine
            // there is nothing left to call, and storing a refresh token you
            // never use is a standing liability for no benefit.
            if (!user) {
              user = createUser(db, {
                googleId: profile.id,
                email,
                displayName: profile.displayName,
                avatar: avatarUrl
              });
            } else {
              user = updateUserProfile(db, user.id, {
                displayName: profile.displayName,
                avatar: avatarUrl
              });
            }
```

et dans `deserializeUser`, remplacer :

```ts
      const user = await prisma.user.findUnique({ where: { id } });
```

par :

```ts
      const user = findUserById(getDb(), id);
```

Les fonctions du dépôt sont synchrones ; les callbacks restent `async` car `downloadAvatar` l'est.

- [ ] **Step 3: Basculer `api/auth.ts`**

Remplacer l'import par :

```ts
import { getDb } from '../db/sqlite.js';
import { upsertDevUser } from '../db/users.js';
```

et remplacer le bloc `prisma.user.upsert` (lignes 66-70) par :

```ts
      const user = upsertDevUser(getDb(), userData);
```

`userData` a déjà exactement la forme attendue : `{ id, email, displayName, googleId, avatar }`.

- [ ] **Step 4: Basculer `api/user.ts`**

Remplacer l'import par :

```ts
import { getDb } from '../db/sqlite.js';
import { findControlsConfig, updateControlsConfig } from '../db/users.js';
```

Puis les trois sites :

```ts
    const stored = findControlsConfig(getDb(), userId);

    if (!stored) {
      // Return default configuration if none saved
      return res.json(getDefaultKeyConfig());
    }

    const config = JSON.parse(stored);
    res.json(config);
```

```ts
    updateControlsConfig(getDb(), userId, JSON.stringify(config));
```

```ts
    updateControlsConfig(getDb(), userId, JSON.stringify(defaultConfig));
```

- [ ] **Step 5: Basculer `services/user-config.ts`**

Remplacer l'import par :

```ts
import { getDb } from '../db/sqlite.js';
import { findControlsConfig } from '../db/users.js';
```

et le corps du `try` :

```ts
    const stored = findControlsConfig(getDb(), userId);

    if (stored) {
      const parsedConfig = JSON.parse(stored);
      cache.set(cacheKey, parsedConfig, 300000); // Cache for 5 minutes
      return parsedConfig;
    }
```

- [ ] **Step 6: Basculer `websocket/index.ts`**

Remplacer l'import par :

```ts
import { getDb } from '../db/sqlite.js';
import { findUserById } from '../db/users.js';
```

et le chargement de l'utilisateur :

```ts
  // Load full user data from database (WebSocket doesn't run deserializeUser)
  const user = findUserById(getDb(), userId);
```

- [ ] **Step 7: Vérifier que rien ne référence plus Prisma sur ce chemin**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
grep -n "prisma" backend/src/auth/passport.ts backend/src/api/auth.ts backend/src/api/user.ts backend/src/services/user-config.ts backend/src/websocket/index.ts backend/src/types/index.ts
npx tsc --noEmit -p backend/tsconfig.json
```

Attendu : aucun résultat du `grep`, et `tsc` sans erreur.

- [ ] **Step 8: Vérifier le comportement réel de la connexion**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
docker compose up -d
npx playwright test --config e2e/playwright.config.ts
```

Attendu : la suite passe. Le `global-setup.ts` de Playwright passe par `/auth/dev/login`, donc c'est `upsertDevUser` qui est exercé — le chemin le plus délicat de cette tâche.

- [ ] **Step 9: Commit (demander l'accord d'abord)**

```bash
git add backend/src/auth/passport.ts backend/src/api/auth.ts backend/src/api/user.ts backend/src/services/user-config.ts backend/src/websocket/index.ts backend/src/types/index.ts
git commit -m "Read users through the repository, not the ORM"
```

### Task 14: Basculer les appelants d'amitiés

**Files:**
- Modify: `backend/src/services/friends.ts:2,10,89`
- Modify: `backend/src/api/friends.ts:4,20,49,74,96,129,133,147,160,187,195,240,252`

**Interfaces:**
- Consumes: tout `backend/src/db/friendships.ts`, `findUserById`/`findUserByEmail`/`searchUsers` de `users.ts`
- Produces: rien de nouveau

- [ ] **Step 1: Basculer `services/friends.ts`**

Remplacer `import { prisma } from '../db/prisma.js';` par :

```ts
import { getDb } from '../db/sqlite.js';
import { listAcceptedFriendshipsFor, listAcceptedFriendshipsWithProfiles } from '../db/friendships.js';
```

`getFriendships` devient :

```ts
export async function getFriendships(userId: string) {
  const cacheKey = `friendships:${userId}`;
  let friendships = cache.get<any[]>(cacheKey);

  if (!friendships) {
    friendships = listAcceptedFriendshipsFor(getDb(), userId);
    cache.set(cacheKey, friendships, 30000); // Cache for 30 seconds
  }

  return friendships;
}
```

`getOnlineFriends` devient :

```ts
export async function getOnlineFriends(
  userId: string,
  presence: { socketFor(userId: string): string | undefined }
): Promise<any[]> {
  const friendships = listAcceptedFriendshipsWithProfiles(getDb(), userId);

  return friendships.map(friendship => {
    const friend = friendship.initiatorId === userId ? friendship.receiver : friendship.initiator;
    // Narrowed on purpose: the old query selected these four columns, and the
    // repository hands back the whole User. Spreading it here would put
    // googleId and the timestamps on the wire.
    return {
      id: friend.id,
      displayName: friend.displayName,
      avatar: friend.avatar,
      email: friend.email,
      online: presence.socketFor(friend.id) !== undefined
    };
  });
}
```

Ce rétrécissement est le seul endroit de la bascule où un `select:` de Prisma ne se traduit pas par une fonction dédiée. Il est explicite et commenté pour cette raison.

- [ ] **Step 2: Basculer les deux listes de `api/friends.ts`**

Remplacer `import { prisma } from '../db/prisma.js';` par :

```ts
import { getDb } from '../db/sqlite.js';
import {
  listAcceptedFriendshipsWithProfiles, listPendingRequestsFor, listFriendshipPairsFor,
  findFriendshipById, findFriendshipBetween, createFriendshipRequest,
  acceptFriendship, deleteFriendship
} from '../db/friendships.js';
import { findUserById, findUserByEmail, searchUsers } from '../db/users.js';
```

Route `GET /` :

```ts
  const friendships = listAcceptedFriendshipsWithProfiles(getDb(), user.id);
```

Route `GET /requests` :

```ts
  const requests = listPendingRequestsFor(getDb(), user.id);
```

- [ ] **Step 3: Basculer la recherche**

Route `GET /search`, remplacer les deux requêtes (lignes 74-108) par :

```ts
  const db = getDb();
  const users = searchUsers(db, user.id, searchQuery, 10);
  const friendships = listFriendshipPairsFor(db, user.id);
```

Le reste de la route — la construction de `friendIds` et le filtre — ne change pas.

- [ ] **Step 4: Basculer l'envoi de demande**

Route `POST /request` :

```ts
  const db = getDb();
  let friend;

  // Search by ID first if provided, otherwise by email
  if (friendId) {
    friend = findUserById(db, friendId);
  } else if (friendEmail) {
    friend = findUserByEmail(db, friendEmail);
  }
```

puis :

```ts
  const existing = findFriendshipBetween(db, user.id, friend.id);
```

et :

```ts
  const friendship = createFriendshipRequest(db, user.id, friend.id);
```

`findFriendshipBetween` remplace le `findFirst` à deux branches `OR` : la fonction du dépôt teste déjà les deux sens.

- [ ] **Step 5: Basculer l'acceptation et la suppression**

Route `POST /accept/:friendshipId` :

```ts
  const db = getDb();
  const friendship = findFriendshipById(db, friendshipId);

  if (!friendship || friendship.receiverId !== user.id) {
    return res.status(404).json({ error: 'Friend request not found' });
  }

  const updated = acceptFriendship(db, friendshipId);
```

Route `DELETE /:friendshipId` :

```ts
  const db = getDb();
  const friendship = findFriendshipById(db, friendshipId);
```

puis :

```ts
  deleteFriendship(db, friendshipId);
```

- [ ] **Step 6: Vérifier**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
grep -n "prisma" backend/src/services/friends.ts backend/src/api/friends.ts
npx tsc --noEmit -p backend/tsconfig.json
npx playwright test --config e2e/playwright.config.ts
```

Attendu : aucun `prisma`, `tsc` propre, suite Playwright verte.

- [ ] **Step 7: Commit (demander l'accord d'abord)**

```bash
git add backend/src/services/friends.ts backend/src/api/friends.ts
git commit -m "Read friendships through the repository, keeping the wire shape"
```

### Task 15: Basculer les appelants de jeux, sauvegardes et métadonnées

**Files:**
- Modify: `backend/src/api/games.ts:4,29,67,74,82,120,124,131,140,154,166,187,198`
- Modify: `backend/src/websocket/game-handlers.ts:3,113,123,138,147,172,226,251`
- Modify: `backend/src/websocket/room-handlers.ts:11,29`
- Modify: `backend/src/services/metadata-loader.ts:4,46,59,85,147,185,204`

**Interfaces:**
- Consumes: tout `games.ts`, `saves.ts`, `game-metadata.ts`
- Produces: rien de nouveau — c'est le dernier appelant

- [ ] **Step 1: Basculer `api/games.ts`**

Remplacer l'import par :

```ts
import { getDb } from '../db/sqlite.js';
import {
  listGamesWithSaveSummaries, listGamesFor, findGameById, findGameWithSaves,
  findGameByChecksum, findOtherGameWithChecksum, countGamesFor, createGame,
  updateGameChecksum, updateGameMetadata, deleteGame
} from '../db/games.js';
```

Les sites, dans l'ordre :

```ts
  const games = listGamesWithSaveSummaries(getDb(), user.id);
```

```ts
  const db = getDb();
  const existing = findGameByChecksum(db, user.id, checksum);
```

```ts
  const count = countGamesFor(db, user.id);
```

```ts
  const game = createGame(db, {
    title: metadata?.title || detected,
    filename,
    crc32: checksum,
    userId: user.id,
    genre: metadata?.genre ?? null,
    publisher: metadata?.publisher ?? null,
    developer: metadata?.developer ?? null,
    releaseDate: metadata?.releaseDate ?? null,
    players: metadata?.players ?? null,
    region: metadata?.region ?? null,
    description: metadata?.description ?? null,
    coverUrl: metadata?.coverUrl ?? null
  });
```

Le spread conditionnel `...(metadata && { ... })` disparaît : `createGame` attend les neuf champs, chacun explicitement `null` en l'absence de métadonnées. C'est plus verbeux et cela supprime une classe de bug — un champ oublié dans le spread laissait la colonne à sa valeur par défaut sans que rien ne le signale.

```ts
  const db = getDb();
  const game = findGameById(db, req.params.gameId);
```

```ts
  const clash = findOtherGameWithChecksum(db, user.id, checksum, game.id);
```

```ts
  const updated = updateGameChecksum(db, game.id, checksum);
```

```ts
  const db = getDb();
  const game = findGameById(db, gameId);
```

```ts
  deleteGame(db, gameId);
```

```ts
  const game = findGameWithSaves(getDb(), gameId);
```

```ts
    const db = getDb();
    const games = listGamesFor(db, user.id);
```

```ts
        updateGameMetadata(db, game.id, {
          title: metadata.title,
          genre: metadata.genre ?? null,
          publisher: metadata.publisher ?? null,
          developer: metadata.developer ?? null,
          releaseDate: metadata.releaseDate ?? null,
          players: metadata.players ?? null,
          region: metadata.region ?? null,
          description: metadata.description ?? null,
          coverUrl: metadata.coverUrl ?? null
        });
```

- [ ] **Step 2: Basculer `websocket/game-handlers.ts`**

Remplacer l'import par :

```ts
import { getDb } from '../db/sqlite.js';
import { findOwnedGameId, saveSram, findSram } from '../db/games.js';
import { findSaveInSlot, findSaveWithGame, createSave, updateSaveData } from '../db/saves.js';
```

Bloc `game:save` :

```ts
      const db = getDb();
      // Saves belong to the game's owner. Without this check a guest in the
      // room would create Save rows against the host's game (mirrors the
      // ownership check in game:load).
      const ownedGameId = findOwnedGameId(db, room.gameId, userId);

      if (!ownedGameId) {
        socket.emit('error', { message: 'Not authorized to save this game' });
        return;
      }

      const existingSave = findSaveInSlot(db, room.gameId, data.slotNumber, userId);

      const saveDataBuffer = data.saveData
        ? Buffer.from(data.saveData, 'base64')
        : Buffer.alloc(0);

      if (existingSave) {
        updateSaveData(db, existingSave.id, data.name, saveDataBuffer);
      } else {
        createSave(db, {
          gameId: room.gameId,
          slotNumber: data.slotNumber,
          name: data.name,
          data: saveDataBuffer,
          screenshot: null
        });
      }
```

Bloc `game:load` :

```ts
      const save = findSaveWithGame(getDb(), data.saveId);
```

Le reste du bloc ne change pas : `save.game.userId`, `save.data.toString('base64')`, `save.slotNumber` et `save.name` gardent leur forme.

Bloc `game:saveSram` :

```ts
      saveSram(getDb(), room.gameId, userId, sramBuffer);
```

Bloc `game:loadSram` :

```ts
      const stored = findSram(getDb(), room.gameId, userId);

      if (!stored) {
        socket.emit('game:sramLoaded', { sramData: null });
        return;
      }

      const sramDataBase64 = stored.sram.toString('base64');
      socket.emit('game:sramLoaded', {
        sramData: sramDataBase64,
        updatedAt: stored.sramUpdatedAt
      });
      logger.info({ gameId: room.gameId, size: stored.sram.length }, 'SRAM loaded');
```

`findSram` renvoie déjà `null` quand la colonne est vide, ce que la double condition `!game || !game.sram` faisait à la main.

- [ ] **Step 3: Basculer `websocket/room-handlers.ts`**

Remplacer `import { prisma } from '../db/prisma.js';` par :

```ts
import { getDb } from '../db/sqlite.js';
import { findChecksumOfOwnedGame } from '../db/games.js';
```

et le site :

```ts
    // Read from the host's library rather than trusting the payload: the guest
    // will use this checksum to pick a file off their own disk, so it has to
    // be the one the server recorded.
    const gameCrc32 = findChecksumOfOwnedGame(getDb(), data.gameId, user.id);
```

puis, dans la construction de la salle, remplacer `gameCrc32: game?.crc32 ?? undefined,` par :

```ts
      gameCrc32: gameCrc32 ?? undefined,
```

- [ ] **Step 4: Basculer `services/metadata-loader.ts`**

Remplacer l'import par :

```ts
import { getDb } from '../db/sqlite.js';
import {
  countGameMetadata, insertGameMetadataBatch, listGameMetadata,
  findGameMetadataByChecksum as findMetadataRowByChecksum, deleteAllGameMetadata
} from '../db/game-metadata.js';
```

L'alias évite une collision : ce fichier exporte déjà une fonction `findGameMetadataByChecksum`.

Le chargement initial, qui insérait entrée par entrée, devient :

```ts
    const db = getDb();
    const existingCount = countGameMetadata(db);

    if (existingCount > 0) {
      logger.info({ count: existingCount }, 'Metadata already loaded, skipping');
      return;
    }

    const successCount = insertGameMetadataBatch(db, metadata.map(entry => ({
      title: entry.title,
      altTitle: entry.altTitle ?? null,
      genre: entry.genre ?? null,
      publisher: entry.publisher ?? null,
      developer: entry.developer ?? null,
      releaseDate: entry.releaseDate ?? null,
      players: entry.players ?? null,
      region: entry.region ?? null,
      description: entry.description ?? null,
      coverUrl: entry.coverUrl ?? null,
      crc32: entry.crc32 ?? null,
      md5: entry.md5 ?? null
    })));

    logger.info({ successCount }, 'Metadata loaded successfully');

    // Load metadata into cache
    metadataCache = listGameMetadata(db);
    logger.info({ count: metadataCache.length }, 'Cached metadata entries in memory');
```

**Changement de comportement à signaler.** La boucle actuelle attrape l'erreur par entrée et compte les échecs (`errorCount`) ; l'insertion par lot est transactionnelle, donc une entrée invalide fait échouer le lot entier. C'est un compromis à assumer explicitement : le catalogue est un fichier livré avec l'image, pas une entrée utilisateur, et un lot qui échoue est un signal plus honnête qu'un compteur d'erreurs que personne ne lit. Le `try/catch` externe existant continue de laisser l'application démarrer sans métadonnées.

Les deux autres sites :

```ts
    metadataCache = listGameMetadata(getDb());
```

```ts
export async function findGameMetadataByChecksum(checksum: string): Promise<any | null> {
  return findMetadataRowByChecksum(getDb(), checksum);
}
```

```ts
  deleteAllGameMetadata(getDb());
```

- [ ] **Step 5: Vérifier qu'aucun appelant ne référence plus Prisma**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
grep -rn "prisma" backend/src --include='*.ts'
```

Attendu : uniquement `backend/src/db/prisma.ts` (supprimé à la Task 16) et le commentaire de `backend/src/db/redis.ts:5`, à reformuler.

```bash
npx tsc --noEmit -p backend/tsconfig.json
npm run test:backend
npx playwright test --config e2e/playwright.config.ts
```

Attendu : `tsc` propre, suites backend vertes, Playwright vert. `local-roms.spec.ts` et `rom-transfer.spec.ts` exercent le chemin des jeux et des sauvegardes.

- [ ] **Step 6: Commit (demander l'accord d'abord)**

```bash
git add backend/src/api/games.ts backend/src/websocket/game-handlers.ts backend/src/websocket/room-handlers.ts backend/src/services/metadata-loader.ts
git commit -m "Read games, saves and metadata through the repositories"
```

### Task 16: Retirer Prisma

**Files:**
- Delete: `backend/src/db/prisma.ts`
- Delete: `backend/prisma/schema.prisma`, `backend/prisma/migrations/`, `backend/prisma/data/`, `backend/prisma/test.db`
- Delete: `backend/test.db`
- Modify: `backend/package.json`
- Modify: `backend/Dockerfile`, `backend/dev.Dockerfile`
- Modify: `docker-compose.yml:47`
- Modify: `backend/src/db/redis.ts:5`
- Modify: `backend/src/index.ts` (appel du runner au démarrage — à confirmer, voir Step 4)

**Interfaces:**
- Consumes: rien
- Produces: rien

- [ ] **Step 1: Vérifier qu'il ne reste aucun appelant**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
grep -rn "@prisma/client\|from '../db/prisma\|from './prisma" backend/src --include='*.ts'
```

Attendu : uniquement `backend/src/db/prisma.ts` lui-même. Toute autre ligne signifie qu'une tâche précédente est incomplète — **ne pas continuer**.

- [ ] **Step 2: Supprimer les fichiers**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
git rm backend/src/db/prisma.ts
git rm -r backend/prisma
git rm --cached backend/test.db 2>/dev/null || true
rm -f backend/test.db
```

`backend/prisma/data/dev.db` est la base locale vide de décembre 2025, sans `_prisma_migrations` — elle ne contient aucune donnée à sauver. `backend/test.db` appartient à root et date de novembre 2025 ; il peut résister à `rm` sans `sudo`, auquel cas le laisser et l'ajouter au `.gitignore`.

- [ ] **Step 2 bis: Ce que le plan ignorait, découvert en cours de route**

Trois choses s'ajoutent à cette tâche et ne figuraient pas dans sa rédaction initiale.

**La production applique ses migrations depuis un autre dépôt.** `pleymor/psnes-online-infra` a son propre `docker-compose.yml`, avec un service `migrations` qui lance `npx prisma migrate deploy` contre `ghcr.io/pleymor/psnes-backend`. Retirer Prisma de l'image sans changer ça casse les migrations de production au déploiement suivant. Cette tâche n'est pas terminée tant que ce service n'invoque pas le nouveau runner, et les deux dépôts doivent changer dans la même fenêtre — un déploiement échouera entre les deux, quel que soit l'ordre.

**`trustedDependencies` liste encore les paquets Prisma.** `package.json` à la racine nomme `@prisma/client`, `@prisma/engines` et `prisma`. Ils partent avec la dépendance. Attention : ce champ **remplace** la liste par défaut de Bun au lieu de l'étendre — c'est écrit dans le fichier, sous la clé `//trustedDependencies` — donc retirer les entrées Prisma ne doit pas retirer par accident celles qui restent nécessaires. Vérifier par `bun pm untrusted` après coup : seul `better-sqlite3` doit y figurer.

**Les numéros de ligne du Dockerfile ont bougé deux fois.** Les Tasks 2 et 7 l'ont réécrit. Repérer `npx prisma generate` et les `COPY` de `prisma/` par leur contenu, pas par les numéros cités plus bas.

**Deux `COPY` que la Task 7 devait retirer et n'a pas retirés.** Son Step 2 demandait de remplacer, dans l'étape `production` :

```dockerfile
COPY --from=builder /app/backend/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
```

C'était faux. `docker-compose.prod.yml` construit **deux** services depuis cette même étape — `db-migration` et `backend` — et le serveur applicatif appelait encore Prisma à l'exécution à ce moment-là. Les supprimer aurait fait échouer `new PrismaClient()` au démarrage. La Task 7 a donc ajouté le `COPY` des migrations à côté et laissé ces deux lignes en place. C'est ici qu'elles partent, puisque c'est ici que plus rien n'en a besoin.

- [ ] **Step 3: Retirer les dépendances et les scripts**

Dans `backend/package.json`, supprimer de `dependencies` :

```json
    "@prisma/client": "^5.22.0",
```

de `devDependencies` :

```json
    "prisma": "^5.22.0",
```

et de `scripts` :

```json
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev"
```

en ajoutant à la place :

```json
    "db:migrate": "node --import tsx src/db/migrate-cli.ts"
```

Puis :

```bash
bun install
du -sh node_modules
```

Attendu : la taille perd environ 86 MB. Consigner la valeur.

- [ ] **Step 4: Appliquer les migrations au démarrage en développement**

Le service `db-migration` de `docker-compose.yml` applique les migrations, mais il `depends_on: backend` — le backend démarre donc avant que les migrations ne soient passées. Cela fonctionnait avec Prisma parce que le client se contentait d'échouer puis de réessayer à la requête suivante.

Vérifier le comportement réel :

```bash
cd /home/pleymor/projects/psnes-repos/psnes
docker compose down -v
docker compose up
```

**`down -v` détruit des données.** Il supprime tous les volumes nommés du projet : la base SQLite de développement, les savestates, les avatars et le cache Redis. C'est voulu ici — tester le chemin de baseline demande une base vierge — mais prévenir la personne qui exécute avant de lancer, et lui laisser sauvegarder `backend-data` si elle y tient.

Si le backend échoue au démarrage sur une base vide, corriger `docker-compose.yml` en inversant la dépendance, comme `docker-compose.prod.yml` le fait déjà :

```yaml
  backend:
    depends_on:
      db-migration:
        condition: service_completed_successfully
      redis:
        condition: service_started
```

et retirer `depends_on: - backend` du service `db-migration`.

- [ ] **Step 5: Retirer `prisma generate` des Dockerfiles et de compose**

Dans `backend/dev.Dockerfile`, supprimer :

```dockerfile
COPY backend/prisma ./prisma
RUN npx prisma generate
```

Dans `backend/Dockerfile`, étape `builder`, supprimer :

```dockerfile
# Copy source code and prisma schema
COPY backend/prisma ./prisma

# Generate Prisma client
RUN npx prisma generate
```

Dans `docker-compose.yml`, service `backend` :

```yaml
    command: sh -c "bun install && npm run dev"
```

- [ ] **Step 6: Reformuler le commentaire de `redis.ts`**

`backend/src/db/redis.ts:5` dit « The one Redis connection, mirroring db/prisma.ts. ». Le fichier cité n'existe plus :

```ts
 * The one Redis connection, mirroring db/sqlite.ts.
```

- [ ] **Step 7: Vérifier de bout en bout**

```bash
cd /home/pleymor/projects/psnes-repos/psnes
npx tsc --noEmit -p backend/tsconfig.json
npm run test:all
docker compose -f docker-compose.prod.yml build
docker compose down -v && docker compose up -d
npx playwright test --config e2e/playwright.config.ts
```

Même avertissement qu'au Step 4 : ce `down -v` efface la base de développement, les savestates, les avatars et Redis. Il est là pour partir d'un état propre avant la suite Playwright ; le dire avant de le lancer.

Attendu : tout vert, et `grep -rn "prisma" backend/ --include='*.ts' --include='*.json' --include='Dockerfile*'` ne renvoie plus rien.

- [ ] **Step 8: Vérifier la bascule sur une base qui vient de Prisma**

C'est le scénario de production, et il n'a encore été testé que par le runner isolé. Reconstruire une base avec Prisma depuis la révision qui précède sa suppression, puis la donner au nouveau runner :

```bash
cd /home/pleymor/projects/psnes-repos/psnes
rm -f /tmp/psnes-handover.db
git worktree add /tmp/psnes-pre-removal HEAD
(cd /tmp/psnes-pre-removal/backend && npm install && DATABASE_URL="file:/tmp/psnes-handover.db" npx prisma migrate deploy)
DATABASE_URL="file:/tmp/psnes-handover.db" node --import tsx backend/src/db/migrate-cli.ts
git worktree remove --force /tmp/psnes-pre-removal
```

`HEAD` désigne ici le dernier commit **avant** celui de cette tâche : les Steps 1 à 7 ne sont pas encore commités, donc la copie de travail du worktree contient encore `backend/prisma/`.

Attendu : `baselined 0001_baseline.sql (schema already present and matching)`, sortie 0. C'est la preuve que le déploiement en production ne réappliquera rien et ne refusera rien à tort.

- [ ] **Step 9: Relever la mesure finale**

```bash
du -sh node_modules
grep -c '"node_modules/' package-lock.json 2>/dev/null || echo "lockfile npm retiré"
```

Comparer aux 257 MB / 461 paquets du point de départ. C'est la preuve que les trois issues demandaient.

- [ ] **Step 10: Commit (demander l'accord d'abord)**

```bash
git add -A
git commit -m "Remove Prisma, 86MB of it, now that nothing calls it"
```

---

## Ce que ce plan ne fait pas

- Il ne migre pas le runtime vers Bun (#10 Partie 2). À rouvrir une fois la phase 3 livrée.
- Il ne touche pas à `simple-peer`, aux polyfills, ni aux modes Dual et Streaming.
- Il ne modifie pas le schéma de la base : la baseline décrit l'existant à l'identique.
- Il ne supprime pas `_prisma_migrations`, laissée inerte comme trace consultable.
