# Bibliothèque par appareil — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La bibliothèque affichée sur un appareil ne contient que les jeux dont cet appareil peut réellement trouver les octets.

**Architecture:** Aucune entité serveur, aucune migration SQL. La bibliothèque d'un appareil est une fonction pure — les identités du compte intersectées avec les checksums résolubles localement. Les checksums résolubles viennent de deux sources : l'index `checksum → filename` que le scan de dossier alimente déjà, et un nouveau store IndexedDB pour les fichiers que le joueur désigne à la main.

**Tech Stack:** TypeScript, SvelteKit, IndexedDB, tests `node:test` via `tsx` (sans DOM).

**Spec:** `docs/superpowers/specs/2026-08-28-bibliotheque-par-device-design.md`

## Global Constraints

- **Les octets d'une ROM ne vont jamais au serveur.** Rien dans ce plan n'envoie de contenu de fichier ; `registerGame` continue de ne poster que `{ checksum, filename }`.
- **Un checksum n'est jamais pris sur parole.** Toute acceptation d'octets recalcule `crc32(normaliseRom(bytes))` et compare. Un nom de fichier n'est jamais une preuve.
- **Le parcours d'invité est intouchable.** Rejoindre la partie d'un ami sur un jeu absent de sa propre bibliothèque doit continuer de fonctionner, transfert de ROM depuis l'hôte compris.
- **Recevoir n'est pas posséder.** Les octets reçus d'un hôte (`sendRom`, `ChunkAssembler`) ne sont jamais écrits dans le store persistant.
- **Tests sans DOM.** Les nouveaux tests tournent sous `node --import tsx --test`, sans `window`, sans IndexedDB réel. Toute dépendance à IndexedDB passe par une interface injectable.
- **Tout nouveau fichier de test doit être ajouté au script `test:ui` dans `package.json`.**

---

### Task 1: Le filtre, en fonction pure

**Files:**
- Create: `frontend/src/lib/roms/device-library.ts`
- Create: `core/test/device-library.test.ts`
- Modify: `package.json:22` (script `test:ui`, ajouter le nouveau fichier)

**Interfaces:**
- Consumes: rien.
- Produces: `deviceLibrary<T extends { crc32?: string | null }>(games: T[], resolvable: Iterable<string>): T[]`

- [ ] **Step 1: Write the failing test**

Créer `core/test/device-library.test.ts` :

```typescript
/**
 * Quels jeux du compte cet appareil peut réellement ouvrir.
 *
 * Une fonction pure sur deux listes, testée sans DOM comme le reste de
 * `roms/` : c'est la seule règle qui décide de ce que le joueur voit, et se
 * tromper ici fait disparaître des jeux qu'il possède.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deviceLibrary } from '../../frontend/src/lib/roms/device-library.js';

const smw = { id: '1', title: 'Super Mario World', crc32: 'aaaa1111' };
const som = { id: '2', title: 'Secret of Mana', crc32: 'bbbb2222' };
const zelda = { id: '3', title: 'A Link to the Past', crc32: 'cccc3333' };

test('un appareil ne montre que ce dont il a les octets', () => {
	const shown = deviceLibrary([smw, som, zelda], ['aaaa1111', 'cccc3333']);
	assert.deepEqual(
		shown.map((g) => g.id),
		['1', '3']
	);
});

test('un appareil sans rien de résoluble montre une bibliothèque vide', () => {
	assert.deepEqual(deviceLibrary([smw, som], []), []);
});

test('un compte vide reste vide, quoi que porte l appareil', () => {
	assert.deepEqual(deviceLibrary([], ['aaaa1111']), []);
});

test("l ordre du compte est conservé : le tri est décidé ailleurs", () => {
	const shown = deviceLibrary([zelda, smw], ['aaaa1111', 'cccc3333']);
	assert.deepEqual(
		shown.map((g) => g.id),
		['3', '1']
	);
});

test('un jeu sans checksum reste visible, parce qu il est réparable', () => {
	// `Game.crc32` est nullable : les entrées créées avant les ROMs locales
	// n'ont pas d'identité, et `needsIdentification` existe pour que le joueur
	// la leur donne. Les masquer supprimerait le seul endroit d'où on peut les
	// rattacher - elles ne sont pas "absentes de cet appareil", elles sont "pas
	// encore identifiées", ce qui est un problème de compte et non d'appareil.
	const orphan = { id: '4', title: 'Inconnu', crc32: null };
	const shown = deviceLibrary([smw, orphan], ['aaaa1111']);
	assert.deepEqual(
		shown.map((g) => g.id),
		['1', '4']
	);
});

test('un checksum absent du compte ne fabrique pas de jeu', () => {
	const shown = deviceLibrary([smw], ['aaaa1111', 'ffff9999']);
	assert.equal(shown.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/device-library.test.ts
```

Attendu : `Cannot find module '.../device-library.js'`.

- [ ] **Step 3: Write minimal implementation**

Créer `frontend/src/lib/roms/device-library.ts` :

```typescript
/**
 * Quels jeux du compte cet appareil peut ouvrir.
 *
 * Le serveur tient l'identité d'un jeu, jamais ses octets, et ceux-ci vivent
 * sur la machine du joueur. Un compte vu depuis un téléphone promet donc des
 * jeux que ce téléphone ne peut pas trouver, et chaque lancement coûte alors un
 * geste que la liste n'avait pas annoncé. Cette fonction est l'endroit unique
 * où l'écran cesse de mentir.
 *
 * Pure et sans DOM pour la même raison que le reste de `roms/` : c'est la seule
 * règle qui décide de ce que le joueur voit, et se tromper ici fait disparaître
 * des jeux qu'il possède réellement.
 */

/** Le strict minimum qu'une entrée de bibliothèque doit porter. */
export interface Identified {
	crc32?: string | null;
}

/**
 * Les jeux de `games` que cet appareil sait résoudre, dans l'ordre reçu.
 *
 * L'ordre est conservé parce que le tri appartient à l'appelant : la page trie
 * par titre avant de filtrer, et refaire ce choix ici le lui volerait.
 *
 * Une entrée **sans checksum** passe le filtre. Elle n'a pas d'octets à trouver
 * puisqu'elle n'a pas encore d'identité, et c'est justement l'écran de la
 * bibliothèque qui offre de la lui donner. La masquer la rendrait irréparable.
 */
export function deviceLibrary<T extends Identified>(
	games: T[],
	resolvable: Iterable<string>
): T[] {
	const here = new Set(resolvable);
	return games.filter((game) => !game.crc32 || here.has(game.crc32));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx --test core/test/device-library.test.ts
```

Attendu : `# pass 6`, `# fail 0`.

- [ ] **Step 5: Add the file to the test suite**

Dans `package.json`, script `test:ui`, ajouter ` core/test/device-library.test.ts` à la fin de la liste des fichiers.

Vérifier : `npm run test:ui` — le total doit augmenter de 6.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/roms/device-library.ts core/test/device-library.test.ts package.json
git commit -m "Filter the library down to what this device can open"
```

---

### Task 2: Le store des fichiers gardés

**Files:**
- Create: `frontend/src/lib/roms/kept-files.ts`
- Create: `core/test/kept-files.test.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: rien.
- Produces:
  - `interface KeptFiles { keep(checksum: string, bytes: Uint8Array): Promise<void>; read(checksum: string): Promise<Uint8Array | null>; checksums(): Promise<string[]>; forget(checksum: string): Promise<void>; }`
  - `function memoryKeptFiles(): KeptFiles`
  - `function indexedDbKeptFiles(): KeptFiles`
  - `function keptFilesAvailable(): boolean`

- [ ] **Step 1: Write the failing test**

Créer `core/test/kept-files.test.ts` :

```typescript
/**
 * Les ROMs qu'un appareil garde parce que le joueur les lui a désignées.
 *
 * L'implémentation de production parle à IndexedDB, qui n'existe pas ici ; ce
 * qui est testé est le contrat, contre l'implémentation mémoire que la
 * production et les tests partagent. Un contrat qui diverge de son
 * implémentation réelle est un piège, donc les deux sont construites côte à
 * côte dans le même fichier.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { memoryKeptFiles, keptFilesAvailable } from '../../frontend/src/lib/roms/kept-files.js';

const bytes = (seed: number) => new Uint8Array([seed, seed + 1, seed + 2]);

test('ce qui a été gardé se relit à l identique', async () => {
	const store = memoryKeptFiles();
	await store.keep('aaaa1111', bytes(10));
	assert.deepEqual([...(await store.read('aaaa1111'))!], [10, 11, 12]);
});

test('un checksum jamais gardé se lit null, pas une exception', async () => {
	const store = memoryKeptFiles();
	assert.equal(await store.read('inconnu'), null);
});

test('les checksums gardés se listent, parce que la bibliothèque en dépend', async () => {
	const store = memoryKeptFiles();
	await store.keep('aaaa1111', bytes(1));
	await store.keep('bbbb2222', bytes(2));
	assert.deepEqual((await store.checksums()).sort(), ['aaaa1111', 'bbbb2222']);
});

test('garder deux fois le même checksum ne le duplique pas', async () => {
	const store = memoryKeptFiles();
	await store.keep('aaaa1111', bytes(1));
	await store.keep('aaaa1111', bytes(9));
	assert.deepEqual(await store.checksums(), ['aaaa1111']);
	assert.deepEqual([...(await store.read('aaaa1111'))!], [9, 10, 11], 'la dernière copie gagne');
});

test('oublier retire des deux vues à la fois', async () => {
	const store = memoryKeptFiles();
	await store.keep('aaaa1111', bytes(1));
	await store.forget('aaaa1111');
	assert.equal(await store.read('aaaa1111'), null);
	assert.deepEqual(await store.checksums(), []);
});

test('oublier ce qui n existe pas ne lève pas', async () => {
	const store = memoryKeptFiles();
	await assert.doesNotReject(() => store.forget('jamais-vu'));
});

test('sans IndexedDB, le stockage se déclare indisponible', () => {
	// Sous node il n'y en a pas. La question doit répondre non plutôt que de
	// lever, parce que l'appelant s'en sert pour décider s'il tente le store.
	assert.equal(keptFilesAvailable(), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test core/test/kept-files.test.ts
```

Attendu : `Cannot find module '.../kept-files.js'`.

- [ ] **Step 3: Write minimal implementation**

Créer `frontend/src/lib/roms/kept-files.ts` :

```typescript
/**
 * Les ROMs qu'un appareil garde parce que le joueur les lui a désignées.
 *
 * Le dossier fait foi là où il y en a un, mais `showDirectoryPicker` n'existe
 * que sur Chromium : sans ce store, Firefox et Safari auraient une
 * bibliothèque définitivement vide et aucun recours - exactement ce contre quoi
 * l'en-tête de `source-state.ts` met en garde. Un fichier désigné à la main
 * entre ici, et l'appareil se remplit au fil des parties.
 *
 * Ce qu'un hôte envoie n'y entre jamais : recevoir n'est pas posséder, et c'est
 * une décision du propriétaire, pas une limitation technique.
 *
 * L'interface existe pour que la règle soit testable sans IndexedDB, sur le
 * modèle de `readDirectionMode` dans `controls/touch.ts`.
 */

const DB_NAME = 'psnes-roms';
/** 2 ajoute le store `files`. La v1 n'avait que `handles` et `index`. */
const DB_VERSION = 2;
const HANDLES = 'handles';
const INDEX = 'index';
const FILES = 'files';

export interface KeptFiles {
	keep(checksum: string, bytes: Uint8Array): Promise<void>;
	read(checksum: string): Promise<Uint8Array | null>;
	checksums(): Promise<string[]>;
	forget(checksum: string): Promise<void>;
}

/** Whether this browser can keep anything at all. */
export function keptFilesAvailable(): boolean {
	return typeof indexedDB !== 'undefined';
}

/** Pour les tests, et pour tout appelant qui ne veut rien persister. */
export function memoryKeptFiles(): KeptFiles {
	const store = new Map<string, Uint8Array>();
	return {
		async keep(checksum, bytes) {
			store.set(checksum, bytes);
		},
		async read(checksum) {
			return store.get(checksum) ?? null;
		},
		async checksums() {
			return [...store.keys()];
		},
		async forget(checksum) {
			store.delete(checksum);
		}
	};
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			// Les trois stores sont créés ici parce qu'une base ouverte en v2 par
			// ce module doit rester complète pour `local-library.ts`, qui ouvre la
			// même base et n'a aucune garantie d'arriver le premier.
			if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
			if (!db.objectStoreNames.contains(INDEX)) db.createObjectStore(INDEX);
			if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** L'implémentation de production. */
export function indexedDbKeptFiles(): KeptFiles {
	return {
		async keep(checksum, bytes) {
			const db = await openDb();
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(FILES, 'readwrite');
				// Une copie : le tableau de l'appelant peut être une vue sur un
				// tampon qu'il réutilise, et IndexedDB structure-clone à la validation
				// de la transaction, pas à l'appel.
				tx.objectStore(FILES).put(bytes.slice(), checksum);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		},
		async read(checksum) {
			const db = await openDb();
			const value = await new Promise<Uint8Array | undefined>((resolve, reject) => {
				const tx = db.transaction(FILES, 'readonly');
				const request = tx.objectStore(FILES).get(checksum);
				request.onsuccess = () => resolve(request.result as Uint8Array | undefined);
				request.onerror = () => reject(request.error);
			});
			db.close();
			return value ?? null;
		},
		async checksums() {
			const db = await openDb();
			const keys = await new Promise<string[]>((resolve, reject) => {
				const tx = db.transaction(FILES, 'readonly');
				const request = tx.objectStore(FILES).getAllKeys();
				request.onsuccess = () => resolve(request.result as string[]);
				request.onerror = () => reject(request.error);
			});
			db.close();
			return keys;
		},
		async forget(checksum) {
			const db = await openDb();
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(FILES, 'readwrite');
				tx.objectStore(FILES).delete(checksum);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		}
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx --test core/test/kept-files.test.ts
```

Attendu : `# pass 7`, `# fail 0`.

- [ ] **Step 5: Bump the schema version in the other module that opens this base**

Dans `frontend/src/lib/roms/local-library.ts`, remplacer `const DB_VERSION = 1;` par :

```typescript
/**
 * 2 ajoute le store `files` (voir `kept-files.ts`).
 *
 * Les deux modules ouvrent la même base et l'un ou l'autre peut arriver le
 * premier, donc les deux doivent connaître la même version et créer les trois
 * stores : ouvrir en v1 après une v2 lève `VersionError` et laisse le joueur
 * sans bibliothèque du tout.
 */
const DB_VERSION = 2;
const FILES = 'files';
```

et, dans `openDb()`, ajouter après la ligne `INDEX` :

```typescript
			if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
```

- [ ] **Step 6: Add the file to the test suite and check nothing regressed**

Ajouter ` core/test/kept-files.test.ts` au script `test:ui` de `package.json`.

```bash
npm run test:ui
```

Attendu : `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/roms/kept-files.ts frontend/src/lib/roms/local-library.ts core/test/kept-files.test.ts package.json
git commit -m "Keep the ROMs a player hands to this device"
```

---

### Task 3: Brancher les fichiers gardés sur la résolution

**Files:**
- Modify: `frontend/src/lib/roms/provider.ts:51-95`
- Modify: `core/test/rom-provider.test.ts`

**Interfaces:**
- Consumes: `KeptFiles`, `memoryKeptFiles`, `indexedDbKeptFiles`, `keptFilesAvailable` (Task 2).
- Produces:
  - `function useKeptFiles(store: KeptFiles | null): void` — remplace le store, pour les tests.
  - `function resolvableHere(): Promise<string[]>` — les checksums que cet appareil sait ouvrir, pour `deviceLibrary`.
  - `resolveQuietly` et `offerFile` gardent leur signature.

- [ ] **Step 1: Write the failing test**

Ajouter à la fin de `core/test/rom-provider.test.ts` :

```typescript
/* --------------------------------------------- les fichiers gardés */

test('un fichier accepté est gardé pour les prochaines fois', async () => {
	const { offerFile, useKeptFiles } = await provider();
	const { memoryKeptFiles } = await import('../../frontend/src/lib/roms/kept-files.js');
	const kept = memoryKeptFiles();
	useKeptFiles(kept);

	const bytes = rom(21);
	const checksum = crc32(normaliseRom(bytes));
	await offerFile(asFile(bytes), checksum);

	assert.deepEqual(await kept.checksums(), [checksum]);
	useKeptFiles(null);
});

test('un fichier refusé n est pas gardé', async () => {
	// Garder une ROM qui ne correspond pas au jeu demandé la rendrait résoluble
	// et injouable : la bibliothèque l'annoncerait et le lancement échouerait.
	const { offerFile, useKeptFiles } = await provider();
	const { memoryKeptFiles } = await import('../../frontend/src/lib/roms/kept-files.js');
	const kept = memoryKeptFiles();
	useKeptFiles(kept);

	await assert.rejects(() => offerFile(asFile(rom(22)), 'ffffffff'));
	assert.deepEqual(await kept.checksums(), []);
	useKeptFiles(null);
});

test('les octets gardés se retrouvent sans rien demander au joueur', async () => {
	const { resolveQuietly, useKeptFiles } = await provider();
	const { memoryKeptFiles } = await import('../../frontend/src/lib/roms/kept-files.js');
	const kept = memoryKeptFiles();
	const bytes = rom(23);
	const checksum = crc32(normaliseRom(bytes));
	await kept.keep(checksum, bytes);
	useKeptFiles(kept);

	assert.deepEqual([...(await resolveQuietly(checksum))!], [...bytes]);
	useKeptFiles(null);
});

test('ce que l appareil sait ouvrir inclut les fichiers gardés', async () => {
	const { resolvableHere, useKeptFiles } = await provider();
	const { memoryKeptFiles } = await import('../../frontend/src/lib/roms/kept-files.js');
	const kept = memoryKeptFiles();
	await kept.keep('aaaa1111', rom(24));
	useKeptFiles(kept);

	assert.deepEqual(await resolvableHere(), ['aaaa1111']);
	useKeptFiles(null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test core/test/rom-provider.test.ts
```

Attendu : échec sur `useKeptFiles is not a function`.

- [ ] **Step 3: Write minimal implementation**

Dans `frontend/src/lib/roms/provider.ts`, ajouter aux imports :

```typescript
import {
	indexedDbKeptFiles,
	keptFilesAvailable,
	type KeptFiles
} from './kept-files.js';
```

Ajouter après la déclaration de `cache` :

```typescript
/**
 * Les octets que cet appareil a gardés, ou null là où rien ne peut l'être.
 *
 * Résolu paresseusement : `keptFilesAvailable()` lit `indexedDB`, qui n'existe
 * pas sous node, et ce module est importé par des tests qui n'en veulent pas.
 */
let keptStore: KeptFiles | null | undefined;

function kept(): KeptFiles | null {
	if (keptStore === undefined) {
		keptStore = keptFilesAvailable() ? indexedDbKeptFiles() : null;
	}
	return keptStore;
}

/** Remplace le store, pour les tests. `null` revient au comportement réel. */
export function useKeptFiles(store: KeptFiles | null): void {
	keptStore = store ?? undefined;
}
```

Remplacer le corps de `resolveQuietly` par :

```typescript
export async function resolveQuietly(checksum: string): Promise<Uint8Array | null> {
	const cached = cache.get(checksum);
	if (cached) return cached;

	// Avant le dossier : lire une entrée d'IndexedDB coûte moins qu'ouvrir un
	// fichier, et un appareil sans dossier n'a que cette source.
	const store = kept();
	if (store) {
		const bytes = await store.read(checksum);
		if (bytes) {
			cache.set(checksum, bytes);
			return bytes;
		}
	}

	if (!supportsDirectoryPicker()) return null;

	const handle = await storedDirectory();
	if (!handle) return null;

	// Permission on a stored folder lapses between sessions, and re-granting it
	// needs a user gesture we do not have here. Silence is the correct answer.
	if (!(await ensureAccess(handle))) return null;

	const bytes = await readRomByChecksum(handle, checksum);
	if (bytes) cache.set(checksum, bytes);
	return bytes;
}

/**
 * Les checksums que cet appareil sait ouvrir sans rien demander.
 *
 * L'union des deux sources, et rien d'autre : c'est ce que la bibliothèque
 * affiche. Le dossier est consulté par son index plutôt que relu, parce que
 * cette question est posée à chaque ouverture de page et qu'un scan de quarante
 * cartouches ne peut pas s'y trouver.
 */
export async function resolvableHere(): Promise<string[]> {
	const here = new Set<string>(cache.keys());

	const store = kept();
	if (store) for (const checksum of await store.checksums()) here.add(checksum);

	if (supportsDirectoryPicker()) {
		for (const checksum of await indexedChecksums()) here.add(checksum);
	}

	return [...here];
}
```

Ajouter `indexedChecksums` à l'import depuis `./local-library.js`.

Dans `offerFile`, remplacer la fin par :

```typescript
	cache.set(expected, bytes);
	// Gardé seulement après validation : une ROM qui ne correspond pas au jeu
	// demandé, une fois gardée, serait annoncée par la bibliothèque et
	// échouerait au lancement.
	await kept()?.keep(expected, bytes);
	return bytes;
```

Dans `frontend/src/lib/roms/local-library.ts`, ajouter :

```typescript
/** Tous les checksums que le dernier scan a laissés dans l'index. */
export async function indexedChecksums(): Promise<string[]> {
	const db = await openDb();
	const keys = await new Promise<string[]>((resolve, reject) => {
		const tx = db.transaction(INDEX, 'readonly');
		const request = tx.objectStore(INDEX).getAllKeys();
		request.onsuccess = () => resolve(request.result as string[]);
		request.onerror = () => reject(request.error);
	});
	db.close();
	return keys;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx --test core/test/rom-provider.test.ts
```

Attendu : `# fail 0`, avec 4 tests de plus qu'avant.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/roms/provider.ts frontend/src/lib/roms/local-library.ts core/test/rom-provider.test.ts
git commit -m "Resolve a game from what this device kept, before the folder"
```

---

### Task 4: L'auto-réparation de l'index

**Files:**
- Modify: `frontend/src/lib/roms/local-library.ts:147-162` (`readRomByChecksum`)
- Modify: `core/test/rom-provider.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: aucune nouvelle signature. `readRomByChecksum` supprime l'entrée d'index quand elle ne mène à rien.

- [ ] **Step 1: Write the failing test**

Ajouter à `core/test/rom-provider.test.ts` :

```typescript
test('un fichier gardé puis oublié cesse d être annoncé', async () => {
	// L'index vaut ce que vaut le dernier scan, et une ROM retirée du dossier y
	// reste. Vérifier le disque à chaque affichage coûterait deux cents accès
	// par ouverture de page ; on répare donc au lancement, le seul moment où
	// l'erreur coûte quelque chose au joueur.
	const { resolvableHere, resolveQuietly, useKeptFiles } = await provider();
	const { memoryKeptFiles } = await import('../../frontend/src/lib/roms/kept-files.js');
	const kept = memoryKeptFiles();
	const bytes = rom(25);
	const checksum = crc32(normaliseRom(bytes));
	await kept.keep(checksum, bytes);
	useKeptFiles(kept);

	assert.deepEqual(await resolvableHere(), [checksum]);

	await kept.forget(checksum);
	assert.deepEqual(await resolvableHere(), [], 'la liste suit le store');
	useKeptFiles(null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test core/test/rom-provider.test.ts
```

Attendu : échec — `resolvableHere` renvoie encore le checksum, parce que le cache de session le retient après `resolveQuietly`.

> Si le test passe du premier coup, c'est que rien dans le test n'a peuplé le cache : ajouter `await resolveQuietly(checksum);` juste après le premier `assert.deepEqual` et relancer. Le point du test est que **le cache de session ne doit pas faire mentir la liste** une fois la source disparue.

- [ ] **Step 3: Write minimal implementation**

Dans `resolvableHere` (`provider.ts`), retirer le cache de session de l'union :

```typescript
export async function resolvableHere(): Promise<string[]> {
	// Le cache de session est délibérément absent : il retient les octets d'une
	// ROM reçue d'un hôte, que le joueur ne possède pas, et il survit à la
	// disparition de la source. Le faire compter ferait exactement mentir la
	// liste que ceci existe pour rendre honnête.
	const here = new Set<string>();

	const store = kept();
	if (store) for (const checksum of await store.checksums()) here.add(checksum);

	if (supportsDirectoryPicker()) {
		for (const checksum of await indexedChecksums()) here.add(checksum);
	}

	return [...here];
}
```

Dans `local-library.ts`, à la fin de `readRomByChecksum`, remplacer `return null;` par :

```typescript
	// Ni le nom mémorisé ni un scan complet n'ont trouvé ce jeu : l'entrée
	// d'index est périmée. La retirer ici corrige la bibliothèque au seul moment
	// où son erreur a coûté quelque chose au joueur.
	await del(INDEX, checksum);
	return null;
```

et ajouter le helper à côté de `get`/`put` :

```typescript
async function del(store: string, key: string): Promise<void> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(store, 'readwrite');
		tx.objectStore(store).delete(key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	db.close();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --import tsx --test core/test/rom-provider.test.ts
npm run test:ui
```

Attendu : `# fail 0` aux deux.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/roms/local-library.ts frontend/src/lib/roms/provider.ts core/test/rom-provider.test.ts
git commit -m "Drop an index entry that no longer leads to a file"
```

---

### Task 5: L'écran, et le parcours d'invité qu'il ne doit pas casser

**Files:**
- Modify: `frontend/src/routes/+page.svelte:4-5, 46-54, 279, 330`
- Modify: `frontend/src/lib/components/RomSourcePanel.svelte`
- Create: `core/test/device-library-guest.test.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: `deviceLibrary` (Task 1), `resolvableHere` (Task 3).
- Produces: rien pour d'autres tâches.

- [ ] **Step 1: Write the failing test**

Créer `core/test/device-library-guest.test.ts` :

```typescript
/**
 * Filtrer sa propre bibliothèque ne doit jamais fermer la partie d'un autre.
 *
 * C'est la régression qui rendrait ce travail nuisible : masquer un jeu parce
 * que cet appareil n'en a pas les octets est une décision d'affichage, et le
 * chemin qui rejoint la partie d'un ami passe par un checksum reçu, pas par la
 * bibliothèque. Ce test épingle cette séparation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deviceLibrary } from '../../frontend/src/lib/roms/device-library.js';
import { crc32, normaliseRom } from '../../frontend/src/lib/roms/checksum.js';

function rom(seed: number, size = 4096): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = (i * seed) & 0xff;
	return bytes;
}

test('un jeu invisible dans la bibliothèque reste jouable en invité', async () => {
	const { remember, isCached, resolveQuietly } = await import(
		'../../frontend/src/lib/roms/provider.js'
	);

	const bytes = rom(31);
	const checksum = crc32(normaliseRom(bytes));

	// Cet appareil ne possède pas ce jeu : il n'apparaît pas dans sa bibliothèque.
	const library = deviceLibrary([{ id: '9', title: 'Le jeu de l ami', crc32: checksum }], []);
	assert.deepEqual(library, [], 'absent de la bibliothèque de cet appareil');

	// L'hôte le lui envoie pendant la partie. Le chemin de jeu passe par le
	// cache de session, que la bibliothèque ignore délibérément.
	remember(bytes);
	assert.equal(isCached(checksum), true);
	assert.deepEqual([...(await resolveQuietly(checksum))!], [...bytes], 'la partie peut démarrer');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --import tsx --test core/test/device-library-guest.test.ts
```

Attendu : `Cannot find module` si la Task 1 n'a pas encore été faite ; sinon le test **passe** — c'est un test de non-régression, et un test de non-régression qui passe d'emblée est correct. Le vérifier maintenant garantit qu'il détectera une régression plus tard.

> Ce test est l'exception assumée à « le test doit d'abord échouer » : il ne décrit pas un comportement à construire mais une propriété à ne pas perdre. Le confirmer vert avant les changements d'écran est ce qui lui donne sa valeur.

- [ ] **Step 3: Filter the library page**

Dans `frontend/src/routes/+page.svelte`, ajouter aux imports :

```typescript
  import { onMount } from 'svelte';
  import { deviceLibrary } from '$lib/roms/device-library';
  import { resolvableHere } from '$lib/roms/provider';
```

(`onMount` est peut-être déjà importé — dans ce cas ne pas le dupliquer.)

Ajouter la déclaration d'état, après les autres `let` du script :

```typescript
  /**
   * Les checksums que cet appareil sait ouvrir.
   *
   * `null` tant qu'on n'a pas regardé : afficher une bibliothèque vide pendant
   * la lecture d'IndexedDB ferait clignoter « aucun jeu » à chaque ouverture de
   * page, ce qui est exactement le mensonge inverse de celui qu'on corrige.
   */
  let resolvable: string[] | null = null;
  onMount(async () => {
    resolvable = await resolvableHere();
  });

  /**
   * Ce que cet appareil peut réellement lancer.
   *
   * Le store `games` reste ce que le compte possède : le panneau ROM du profil
   * s'en sert pour dire combien de jeux ne sont pas ici.
   */
  $: shownGames = resolvable === null ? $games : deviceLibrary($games, resolvable);
```

Remplacer le compteur (`:279`) :

```svelte
          <p class="subtitle">{shownGames.length} {shownGames.length === 1 ? t($language, 'game') : t($language, 'games')}</p>
```

Remplacer les deux usages de `$games` dans le bloc d'affichage (`:321` et `:330`) :

```svelte
        {#if shownGames.length === 0}
```

```svelte
            {#each shownGames as game}
```

- [ ] **Step 4: Tell the truth in the profile panel**

Dans `frontend/src/lib/components/RomSourcePanel.svelte`, ajouter une prop et une ligne. Aux props du script :

```typescript
  /**
   * Combien de jeux du compte cet appareil ne peut pas ouvrir.
   *
   * La bibliothèque les masque, ce qui est le comportement demandé ; les faire
   * disparaître sans le dire nulle part serait un autre mensonge. Ici est
   * l'endroit : on y vient déjà pour configurer ses ROMs.
   */
  export let missingCount = 0;
```

Juste après le `<h3>` du `<section class="rom-source">` :

```svelte
  {#if missingCount > 0}
    <p class="explain">{missingCount} {t($language, 'gamesNotOnThisDevice')}</p>
  {/if}
```

Dans `frontend/src/lib/i18n/translations.ts`, ajouter la clé aux **deux** objets de langue, à côté de `romFolderUnsupported` (anglais vers `:90`, français vers `:450`) :

```typescript
    // anglais
    gamesNotOnThisDevice: 'games in your library are not on this device.',
```

```typescript
    // français
    gamesNotOnThisDevice: 'jeux de votre bibliothèque ne sont pas sur cet appareil.',
```

Dans `frontend/src/routes/profile/+page.svelte`, le panneau est utilisé en `:311`. Ajouter aux imports :

```typescript
  import { games } from '$lib/stores/games';
  import { deviceLibrary } from '$lib/roms/device-library';
  import { resolvableHere } from '$lib/roms/provider';
```

Ajouter l'état, avec le même `null` prudent que sur la home :

```typescript
  let resolvable: string[] | null = null;
  onMount(async () => {
    resolvable = await resolvableHere();
  });
  // Zéro tant qu'on n'a pas regardé : annoncer « 200 jeux absents » pendant la
  // lecture d'IndexedDB serait alarmant et faux.
  $: missingCount =
    resolvable === null ? 0 : $games.length - deviceLibrary($games, resolvable).length;
```

Et passer la prop en `:311` :

```svelte
      <RomSourcePanel {missingCount}>
```

- [ ] **Step 5: Note what is already covered, and check it**

La spec demande aussi que **créer une room ne propose que des jeux jouables ici**. Aucune tâche supplémentaire : le sélecteur de jeu *est* la bibliothèque — `GameCard` (`+page.svelte:331`) déclenche le lancement via `rooms/game-click.ts`, et il n'itère plus que sur `shownGames`. Le vérifier plutôt que le supposer : après le changement, un jeu absent de l'appareil ne doit avoir **aucune** carte, donc aucun bouton de lancement.

- [ ] **Step 6: Verify the whole thing**

```bash
npm run test:ui
npm run test:netplay
cd frontend && npm run check && npm run build && cd ..
```

Attendu : `# fail 0` partout, `0 errors` pour svelte-check, et un build qui aboutit.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/routes/+page.svelte frontend/src/lib/components/RomSourcePanel.svelte frontend/src/routes/profile/+page.svelte frontend/src/lib/i18n/translations.ts core/test/device-library-guest.test.ts package.json
git commit -m "Show only the games this device can actually open"
```

---

## Vérification manuelle avant de déclarer fini

Rien de ce qui suit n'est couvert par les tests, et chacun a une chance réelle de casser :

- [ ] **Sur le poste de bureau, dossier désigné** — la bibliothèque montre les jeux du dossier et rien d'autre. Le compteur suit.
- [ ] **Retirer une ROM du dossier, la lancer** — le lancement échoue proprement, et après un rechargement elle a disparu de la liste.
- [ ] **Sur un navigateur sans `showDirectoryPicker`** (Firefox, ou le téléphone) — la bibliothèque est vide au départ, désigner un fichier le fait apparaître, et il est **toujours là après un rechargement**. C'est le test qui valide la décision « on garde ce qu'on désigne ».
- [ ] **Le parcours d'invité en vrai** — rejoindre la partie d'un ami sur un jeu absent de sa bibliothèque, et vérifier que le transfert depuis l'hôte fonctionne toujours. C'est la régression la plus coûteuse de ce lot.
- [ ] **Rejouer ce même jeu ensuite en solo** — il ne doit **pas** apparaître dans la bibliothèque : recevoir n'est pas posséder.
- [ ] **La question Android**, restée ouverte dans la spec — ouvrir `/profile` sur le téléphone et noter si le bouton « choisir un dossier » est offert ou si c'est le repli fichier unique.
