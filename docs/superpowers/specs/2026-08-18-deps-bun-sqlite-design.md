# Alléger les dépendances, passer à Bun, sortir de Prisma

Conception pour les issues #10, #11 et #13.

## Ce que le repo dit aujourd'hui

Les chiffres des issues ont vieilli. Mesures du 18 août 2026, sur `main` à `9571cec` :

| | Issue | Réel |
|---|---|---|
| Packages | 638 | **461** (`package-lock.json`) |
| `node_modules` | 468 MB | **257 MB** |
| `googleapis` | 116 MB | **absent** — parti avec #12 |
| `adm-zip` | à supprimer | **absent** — parti avec #12 |
| Prisma | 86 MB | **86 MB**, soit un tiers du total |
| Migrations enregistrées | six | **huit** |
| Modèles | six | **cinq** — `User`, `Friendship`, `Game`, `Save`, `GameMetadata` |

#12 a donc déjà emporté la moitié de #11. Prisma est aujourd'hui, et de loin, le poste le plus lourd : `node_modules/prisma` (42 MB) et `node_modules/@prisma` (44 MB) devant TypeScript (23 MB) et playwright-core (14 MB).

## Ce que le sondage a établi

Les deux pièges que #13 signalait comme incertains ont été mesurés contre une base reconstruite à partir des huit fichiers de migration.

**Dates.** Les colonnes sont déclarées `DATETIME`, mais SQLite n'a pas ce type et Prisma y écrit un **entier, millisecondes depuis epoch** — vérifié par `typeof(createdAt)` sur une ligne écrite par le client Prisma lui-même. Ce n'est donc pas « des chaînes ou des entiers selon la colonne » : c'est une règle unique. Un driver brut rend un `number` ; la conversion est `new Date(n)` en lecture et `.getTime()` en écriture, sans exception.

**Blobs.** `typeof(data)` vaut `blob`, et Prisma rend un `Buffer`. `better-sqlite3` rend également un `Buffer` et accepte un `Buffer` en liaison : sur ce point, **aucun appelant ne change**. `node:sqlite` et `bun:sqlite` rendraient un `Uint8Array` — c'est une raison de plus de choisir `better-sqlite3`, au-delà de sa portabilité Node/Bun.

Constat annexe, sans rapport avec la conception mais révélateur : le client Prisma généré dans `node_modules` était périmé, il connaissait encore la colonne `googleAccessToken` supprimée par la dernière migration. Un `prisma generate` l'a corrigé. C'est une classe entière de dérive qui disparaît avec l'issue.

## L'état des tests, qui contraint tout le reste

**Le backend n'a aucun test unitaire.** `find backend -name '*.test.ts'` ne renvoie rien. La couverture existante est ailleurs :

- `core/test/` — 12 suites, sur le netplay et le lockstep côté frontend
- `e2e/` — Playwright, dont `room-authz.spec.ts` et `local-roms.spec.ts` traversent les chemins de données

Réécrire 50 appels de base de données sur 11 fichiers sans filet n'est pas envisageable. Les modules de dépôt de l'étape 3 sont donc écrits en TDD, contre un fichier SQLite temporaire — ce que `better-sqlite3` rend trivial : synchrone, adossé à un fichier, aucun serveur à lancer. Ces tests sont le premier livrable de l'étape 3, pas le dernier.

## Séquence

Quatre étapes, du risque nul au risque réel. Chacune est indépendamment livrable et réversible.

### Étape 1 — Reliquat de #11

Retirer ce qui n'a aucun consommateur, vérifié par recherche dans `backend/src`, `frontend/src` et `core` :

- `@sveltejs/adapter-auto`, `@sveltejs/adapter-node` — `frontend/svelte.config.js:1` utilise `adapter-static`
- `stream-browserify`, `util` — déclarés et aliasés dans `frontend/vite.config.ts:11-17`, jamais importés
- les entrées correspondantes dans `resolve.alias` et `optimizeDeps.include` de `vite.config.ts`

**Correction : `events` reste, contrairement à ce que cette spec disait d'abord.** « Aucun importeur dans `src` » ne veut pas dire « aucun importeur ». `simple-peer` tire `readable-stream`, dont le champ `browser` neutralise `util` (`"util": false`) et redirige `stream`, mais ne prévoit rien pour `events` : son `stream-browser.js` fait `require('events').EventEmitter` sans repli. Sans le paquet ni son alias, Vite externalise cet import vers un stub vide **sans faire échouer le build** — `EventEmitter` devient `undefined` dans le bundle, et le WebRTC casse à l'exécution. Le retrait a été tenté, l'inspection du bundle l'a montré, `events` a été remis seul.

La leçon vaut au-delà de ce paquet : une recherche d'imports dans `src` ne prouve rien pour les polyfills, dont l'unique consommateur est toujours une dépendance transitive. Les trois autres ont été retirés sur la même preuve — bundle construit, suite Playwright passante — et non sur le seul `grep`.

**Ce qui reste en place.** `simple-peer` porte `frontend/src/lib/webrtc/p2p-manager.ts` (778 lignes), lui-même requis par `dual-mode.ts`, `streaming-mode.ts` et `network-detector.ts`, tous encore câblés depuis `P2PRoom.svelte:1101`. `buffer`, `process`, `path-browserify` et donc `events` le servent. Les supprimer reviendrait à supprimer les modes Dual et Streaming — une décision produit, qui mérite son issue et non l'effet de bord d'un nettoyage de dépendances.

**Vérification.** `npm run build` du frontend, et `du -sh node_modules` avant/après.

### Étape 2 — #10 Partie 1, Bun comme package manager

Node reste le runtime. Bun n'installe que.

| Fichier | Changement |
|---|---|
| `backend/Dockerfile` | `npm ci --omit=dev --prefer-offline` → `bun install --production --frozen-lockfile` ; `npm ci --prefer-offline` → `bun install --frozen-lockfile` ; `npm run build` → `bun run build` |
| `backend/dev.Dockerfile` | `npm install` → `bun install` |
| `frontend/Dockerfile` | `npm install` → `bun install` ; `npm run build` → `bun run build` |
| `docker-compose.yml:47` | `sh -c "npm install && npx prisma generate && npm run dev"` → équivalent Bun |
| `docker-compose.yml:64` | `sh -c "npm install && npm run dev -- --host"` → équivalent Bun |
| `package.json` | workspaces npm → workspaces Bun |

C'est le `npm install` à chaque démarrage de conteneur, sur 461 packages, qui est visé — la lenteur quotidienne que décrit #10.

**Ce qui ne bouge pas à cette étape.** Les scripts de test restent sur `node --import tsx --test`. Le piège que décrit #10 — porter les suites netplay vers `bun test`, dont les API d'assertion et de mock diffèrent — ne concerne que la Partie 2. Tant que Node exécute, `tsx` reste nécessaire et les 12 suites tournent inchangées. C'est précisément ce que la séparation en deux parties achète.

Les images Node des Dockerfiles gagnent Bun par copie du binaire depuis l'image officielle — `COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun` — plutôt que par un script d'installation. L'image de base reste `node:20`, puisque Node exécute toujours ; la copie est une couche unique et déterministe, qui ne casse pas le cache à chaque build comme le ferait un `curl | bash`.

**Vérification.** `docker compose up --build` démarre ; les 12 suites `core/test` passent ; la suite Playwright passe.

**Retour arrière.** Rétablir les lignes `npm` et supprimer `bun.lockb`. `package-lock.json` reste au dépôt jusqu'à ce que l'étape soit jugée stable.

### Étape 3 — #13, Prisma → `better-sqlite3`

Le gros morceau. 86 MB, 50 opérations de modèle, 11 fichiers.

#### Forme : des modules de dépôt par modèle

Cinq nouveaux fichiers sous `backend/src/db/`, un par modèle : `users.ts`, `games.ts`, `friendships.ts`, `saves.ts`, `game-metadata.ts`. Chacun exporte des fonctions nommées, pas un objet générique :

```ts
// backend/src/db/friendships.ts
export function listPendingRequestsFor(userId: string): PendingRequest[] {
  return stmt.pending.all(userId).map(toPendingRequest);
}
```

Les appelants perdent la mécanique et gardent leur forme :

```ts
// backend/src/api/friends.ts
- const rows = await prisma.friendship.findMany({
-   where: { receiverId: userId, status: 'pending' },
-   include: { initiator: true },
- });
+ const rows = listPendingRequestsFor(userId);

  rows.map(f => f.initiator.displayName)   // inchangé
```

Trois propriétés de cette forme comptent :

**Les huit jointures ne se propagent pas.** Les clauses `include:` de `services/friends.ts:97`, `api/friends.ts:28,54,166,198`, `websocket/game-handlers.ts:174` et `api/games.ts:31,168` rendent aujourd'hui des objets imbriqués que les appelants déstructurent — `f.initiator.displayName`, `save.game.userId`, `game.saves`. Chaque jointure devient une fonction qui rend déjà cette forme imbriquée, assemblée dans le module de dépôt. C'est le gros du travail, comme le disait #13, mais il est confiné à cinq fichiers au lieu d'être étalé sur onze.

**Le driver est enfermé.** Aucun `import` de `better-sqlite3` en dehors de `backend/src/db/`. C'est ce qui permettra à l'étape 4 de basculer sur `bun:sqlite` en touchant cinq fichiers — la seule différence sensible étant `Buffer` contre `Uint8Array`, qui sera alors localisée dans les fonctions de conversion.

**Les dates ont un seul point de passage.** Chaque module expose des convertisseurs `toUser`, `toGame`, `toSave` qui transforment la ligne brute en objet typé. Le `new Date(n)` y vit, une fois par modèle, au lieu d'être dispersé sur 50 sites.

#### Types

La surface est plus petite que ne le dit #13. Deux fichiers seulement importent `@prisma/client` : `backend/src/db/prisma.ts:1` pour le client, et `backend/src/types/index.ts:1`, qui importe `User` et le ré-exporte sous forme d'interface. L'issue mentionne aussi `rom-source.ts` et `presence.ts` : le premier n'existe plus, et le second ne référence Prisma nulle part — cette partie de #13 est périmée.

Le type `User` devient donc une interface écrite à la main dans `backend/src/db/types.ts`, aux côtés de `Game`, `Save`, `Friendship` et `GameMetadata`, dérivées du schéma actuel.

Autre confirmation du sondage : aucune occurrence de `prisma.$queryRaw`, `prisma.$executeRaw` ni `prisma.$transaction` dans `backend/src`. Le diagnostic de #13 — pas de transactions, pas d'agrégats — tient.

#### Deux pièges que #13 ne mentionne pas

La lecture des 50 sites en a révélé deux autres, tous deux silencieux — c'est ce qui les rend dangereux : rien n'échoue, les valeurs sont simplement fausses ou les lignes simplement orphelines.

**Prisma remplissait trois colonnes que personne n'écrivait.** `@default(uuid())` fabriquait les `id`, `@default(now())` les `createdAt`, et surtout `@updatedAt` avançait les `updatedAt` à chaque écriture. Aucun appelant ne les mentionne, et aucun ne s'en apercevra s'ils cessent d'être remplis. Or `updatedAt` est visible : `api/friends.ts:38` l'envoie au client comme date d'amitié (`friendsSince`). Chaque `INSERT` fournit donc les trois valeurs, et chaque `UPDATE` sur une table qui porte `updatedAt` la fournit aussi. Les tests de dépôt vérifient explicitement que la date avance.

**SQLite désactive les clés étrangères par défaut.** Le schéma déclare `onDelete: Cascade` sur `Game → Save`, `User → Game` et `User → Friendship`, et `api/games.ts:154` supprime un jeu en comptant dessus pour emporter ses sauvegardes. Prisma activait le pragma ; un driver brut ne le fait pas spontanément. `PRAGMA foreign_keys = ON` est donc appliqué à chaque ouverture de connexion, et testé — supprimer un parent doit laisser zéro enfant.

#### Où vivent les migrations

`backend/migrations/`, et non `backend/src/db/migrations/` : `tsc` ne copie pas les fichiers `.sql` vers `dist/`, donc des migrations placées sous `src/` seraient absentes de l'image de production. Le Dockerfile copie ce répertoire explicitement, comme il copiait `backend/prisma`.

#### Runner de migrations

C'est la partie où #7 peut se rejouer, et elle est traitée comme telle.

- Répertoire `backend/migrations/`, un fichier `0001_baseline.sql` contenant le schéma d'aujourd'hui, puis `0002_…` pour la suite.
- Table `schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER)`, propre au runner.
- Au démarrage sur une base **vide** : la baseline s'exécute, puis les suivantes.
- Au démarrage sur une base **existante** : le runner compare le `sqlite_master` vivant à celui qu'une baseline fraîche produit. **Identiques** → il enregistre `0001_baseline` sans l'exécuter, puis applique les migrations postérieures. **Différents** → il refuse de démarrer et affiche la différence.

Ce refus est le cœur de la conception, pas un raffinement. Le reproche de #7 à `prisma db push` n'était pas qu'il appliquait le schéma, c'est que personne ne vérifiait que la base réelle correspondait aux fichiers — une dérive pouvait être gelée sans que quiconque la voie. Un runner qui estampille aveuglément reproduirait exactement ce trou.

Les huit `migration.sql` de Prisma ne sont pas portés. Ils contiennent la chorégraphie de reconstruction de tables de Prisma (`PRAGMA defer_foreign_keys`, table `new_Game`, copie, `DROP`, `RENAME`) et sur toute base existante ils ne se rejoueront jamais. Leur histoire reste lisible dans git, où elle a toujours été.

`_prisma_migrations` n'est pas lue et pas supprimée : elle devient inerte. La laisser en place coûte quelques kilo-octets et garde une trace consultable si un doute survient sur ce qui a été appliqué avant la bascule.

#### Ce qui disparaît

`@prisma/client` et `prisma` des dépendances ; `backend/prisma/schema.prisma` et `backend/prisma/migrations/` ; les scripts `db:generate` et `db:migrate` ; l'étape `npx prisma generate` de `backend/Dockerfile:41` et `backend/dev.Dockerfile:16` ; la commande `npx prisma migrate deploy` du service `db-migration` dans `docker-compose.yml:19` et `docker-compose.prod.yml:19`, remplacée par l'invocation du nouveau runner.

`better-sqlite3` est un module natif : `backend/Dockerfile` installe déjà `python3 make g++` en étape de build, la chaîne est donc présente. L'étape d'exécution copie les `node_modules` de production — le binaire compilé doit y être ; à vérifier à l'implémentation, c'est le point de rupture le plus probable du build Docker.

#### Ordre de travail, sous TDD

1. Le runner de migrations et son test : base vide, base existante conforme, base existante divergente (qui doit échouer).
2. Les cinq modules de dépôt, un par un, chacun avec ses tests contre un fichier SQLite temporaire. Les jointures d'abord, ce sont elles qui portent le risque.
3. La bascule des appelants, un fichier à la fois, en s'appuyant sur les tests qui existent désormais.
4. Suppression de Prisma une fois qu'aucun appelant ne le référence.

**Vérification.** Les nouveaux tests de `backend/src/db/` ; les 12 suites `core/test` ; la suite Playwright, en particulier `room-authz.spec.ts` et `local-roms.spec.ts` ; `du -sh node_modules`, qui doit perdre environ 86 MB.

### Étape 4 — #10 Partie 2, Bun comme runtime

Hors périmètre de ce travail, et volontairement. À rouvrir une fois l'étape 3 livrée, quand le risque aura changé de nature : Prisma parti, le binaire natif du moteur de requêtes n'est plus un obstacle, et il ne reste que `socket.io` côté serveur sur la couche de compatibilité node de Bun, `pino` et ses transports en thread de travail, et le portage des suites de test vers `bun test`.

Ce que l'étape 4 gagnerait alors : `tsx` et `dotenv` disparaissent, et `better-sqlite3` peut céder la place à `bun:sqlite` en ne touchant que `backend/src/db/`.

## Mesures

#11 demande de mesurer, faute de quoi l'exercice devient du rangement sans preuve. Relevé avant chaque étape et après :

- `du -sh node_modules`
- `grep -c '"node_modules/' package-lock.json`, ou l'équivalent Bun après l'étape 2
- durée d'une installation à froid, cache vidé

Point de départ, 18 août 2026 : **461 packages, 257 MB.**

## Ce que cette conception ne fait pas

- Elle ne touche pas aux modes Dual et Streaming, ni à `simple-peer`, ni aux polyfills qui les servent.
- Elle ne migre pas le runtime vers Bun.
- Elle n'ajoute ni transactions, ni `groupBy`, ni agrégats : les 50 appels n'en utilisent aucun, et les modules de dépôt n'exposeront que ce qui est appelé.
- Elle ne modifie pas le schéma de la base. La baseline décrit l'existant, à l'identique.
