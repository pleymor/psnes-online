# Passe d'architecture maintenabilité — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Réduire le coût de modification du code — code mort supprimé, fichiers de plus de 1 000 lignes découpés par responsabilité, duplication éliminée, documentation d'architecture remise en accord avec le produit — sans changer ce que voit le joueur.

**Architecture:** Extraction par couche, du bas vers le haut. Les utilitaires partagés d'abord, puis la logique pure sortie de `znet/session.ts`, puis le backend, puis les composants Svelte qui consomment ces utilitaires, puis la page room, puis la documentation. Chaque tâche laisse l'arbre compilable et les suites vertes.

**Tech Stack:** TypeScript, Svelte 4 + SvelteKit, Express + socket.io, better-sqlite3, node:test via tsx, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-26-architecture-maintainability-design.md`

## Global Constraints

- **Aucun changement de comportement observable**, sauf le correctif base64 de la tâche 3, qui est le seul autorisé et est explicitement décrit.
- **Les modes STREAMING et DUAL ne sont pas refactorés.** `P2PRoom.svelte`, `netplay/`, `multiplayer/`, `webrtc/`, `ClientEmulator.svelte`, `DualClientEmulator.svelte` sont hors périmètre, à l'exception de la ligne `P2PRoom.svelte:280` (tâche 3).
- **Les assertions des tests existants ne sont jamais modifiées.** Un test qu'il faut réécrire pour le faire passer signale une erreur d'extraction, pas un test à corriger.
- **La surface publique de `znet/session.ts` reste identique**, ré-exports compris : `NetplaySession`, `suggestInputDelay`, `NetplayCore`, `SessionEvent`, `SessionOptions`, `SessionState`, `SessionStats`, `TickResult`, `TickSource`. `core/test/netcode.test.ts`, `core/test/harness.ts` et `frontend/src/lib/znet/index.ts` ne sont pas modifiés.
- **Node :** utiliser Node 20 pour tout ce qui touche la base de données et les tests. `node` n'est pas sur le PATH par défaut ; préfixer par `export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"`. Un `npm` nu est celui de Windows et échoue.
- **Règle Svelte 4, non négociable.** Toute valeur réactive consommée par du code extrait est passée en **paramètre explicite**, de sorte que son identifiant apparaisse sur le site d'appel. Aucune fonction extraite ne lit d'état réactif depuis son corps. `$: x = f()` ne corrige rien : cela déplace l'initialisation unique. Vérifié par `scripts/svelte-frozen-props.mjs`, pas par relecture.
- **Commits :** le propriétaire du dépôt demande son accord avant tout commit. Les étapes « Commit » de ce plan préparent le message et l'index ; demander avant d'exécuter `git commit`.

---

## Structure des fichiers

**Créés**

| Fichier | Responsabilité |
|---|---|
| `scripts/svelte-frozen-props.mjs` | détecte les expressions réactives que Svelte 4 compile en initialisation unique |
| `frontend/src/lib/znet/pad-timeline.ts` | les pads et les CRC des deux joueurs, indexés par frame absolue |
| `frontend/src/lib/znet/link-metrics.ts` | ce que le lien fait, mesuré : RTT, gigue, frames tardives, tension du pair |
| `frontend/src/lib/znet/delay-control.ts` | la politique de délai d'entrée : calibrage, montée, descente |
| `frontend/src/lib/rooms/sram.ts` | lecture et application du SRAM |
| `frontend/src/lib/rooms/renderer-surface.ts` | cycle de vie 2D/WebGL et chargement de preset |
| `frontend/src/lib/rooms/input-sources.ts` | affectation des périphériques aux collecteurs |
| `frontend/src/lib/rooms/fullscreen.ts` | bascule plein écran |
| `frontend/src/lib/rooms/chrome-autohide.ts` | minuterie de la barre d'outils |
| `frontend/src/lib/rooms/room-session.ts` | état de room et abonnement socket |
| `backend/src/websocket/invitation-handlers.ts` | les quatre événements `lobby:*` |
| `backend/src/bootstrap/env-guard.ts` | refus de démarrer sur un secret inutilisable |
| `backend/src/bootstrap/app.ts` | Express, session, passport, routeurs |
| `backend/src/bootstrap/jobs.ts` | tâches de fond et restauration |
| `backend/src/bootstrap/shutdown.ts` | arrêt gracieux |
| `core/test/pad-timeline.test.ts`, `core/test/link-metrics.test.ts`, `core/test/delay-control.test.ts` | tests unitaires des modules extraits |
| `docs/history/README.md` | index des instantanés archivés |

**Modifiés :** `frontend/src/lib/saves/base64.ts`, `frontend/src/lib/znet/session.ts`, `frontend/src/lib/components/{LockstepRoom,SoloRoom}.svelte`, `frontend/src/routes/room/[id]/+page.svelte`, `backend/src/websocket/{room-handlers,index}.ts`, `backend/src/index.ts`, `package.json`, `ARCHITECTURE.md`.

**Supprimés :** les dix fichiers de la tâche 4.

---

## Task 1 : L'instrument de détection Svelte

Rien d'autre ne peut être vérifié dans les chantiers 3 et 5 sans lui. Il est écrit et calibré en premier, parce qu'un détecteur non calibré donne une fausse assurance.

**Files:**
- Create: `scripts/svelte-frozen-props.mjs`

**Interfaces:**
- Consumes: rien
- Produces: `node scripts/svelte-frozen-props.mjs <fichier.svelte>...` — sortie `<fichier>` puis `  <où>: <fn>() leaves <ids> untracked` par site ; sortie 1 s'il y a au moins un site, 0 sinon.

- [ ] **Step 1 : Écrire le script**

Il analyse l'AST plutôt que le code généré : la question n'est pas « ce nom est-il réactif » mais « cette expression réactive suit-elle ce que son appelée lit ». Dans `GameDetailsModal`, `{t($language, 'genre')}` est vivant et `{formatDate(game.releaseDate)}` est gelé — même composant, même store.

Le fichier complet est donné ici ; il est autonome.

```js
/**
 * Finds reactive expressions that Svelte 4 silently compiles to run once.
 *
 * Svelte 4 derives a reactive statement's dependency set from the identifiers
 * written in the statement itself. A `$:` or a template expression that calls a
 * *function declaration* whose body reads reactive state therefore has no
 * dependency on that state: the compiler emits the expression as one-time
 * initialisation, with no error and no warning. `{formatDate(game.releaseDate)}`
 * updates when `game` changes and never when `$language` does.
 *
 * The two cases are indistinguishable in the source, which is why this exists.
 * A function *expression* assigned in a `$:` is traced correctly and is not
 * reported.
 *
 * This is a lint, not a prover: it reports call sites whose dependencies are
 * narrower than what the callee reads, and names the reactive state that goes
 * untracked. Judgement still decides whether that state was meant to be tracked
 * - an imperative effect guarded on the right condition is reported and is fine.
 *
 * Usage: node scripts/svelte-frozen-props.mjs <component.svelte>...
 * Exits non-zero if any call site is reported, so it can gate a commit.
 */
import { parse, walk } from 'svelte/compiler';
import { transformSync } from 'esbuild';
import fs from 'node:fs';

function stripTypes(source) {
	return source.replace(
		/<script([^>]*\blang=["']ts["'][^>]*)>([\s\S]*?)<\/script>/g,
		(_m, attrs, body) =>
			`<script${attrs.replace(/\s*lang=["']ts["']/, '')}>` +
			transformSync(body, { loader: 'ts', target: 'esnext' }).code +
			'</script>'
	);
}

/** Identifiers a node reads, ignoring property names and declarations. */
function readsOf(node) {
	const found = new Set();
	walk(node, {
		enter(n, parent, key) {
			if (n.type !== 'Identifier') return;
			if (parent && parent.type === 'MemberExpression' && key === 'property') return;
			if (parent && parent.type === 'Property' && key === 'key') return;
			if (parent && /Function|VariableDeclarator|ClassDeclaration/.test(parent.type) && key === 'id') return;
			found.add(n.name);
		}
	});
	return found;
}

let reported = 0;

for (const file of process.argv.slice(2)) {
	const ast = parse(stripTypes(fs.readFileSync(file, 'utf8')));
	if (!ast.instance) continue;

	const callables = new Map();
	for (const node of ast.instance.content.body) {
		if (node.type === 'FunctionDeclaration' && node.id) {
			callables.set(node.id.name, node);
		} else if (node.type === 'VariableDeclaration') {
			for (const d of node.declarations) {
				if (d.id.type === 'Identifier' && d.init &&
					/ArrowFunctionExpression|FunctionExpression/.test(d.init.type)) {
					callables.set(d.id.name, d.init);
				}
			}
		}
	}

	/*
	 * Reactive state the component holds: store reads, props, and `let`
	 * bindings. `const` is excluded on purpose - it is never reassigned, so a
	 * callee reading one cannot go stale, and including them buried the real
	 * findings under every logger and every event dispatcher in the file.
	 */
	const reactive = new Set();
	for (const node of ast.instance.content.body) {
		if (node.type === 'VariableDeclaration') {
			if (node.kind === 'const') continue;
			for (const d of node.declarations) {
				if (d.id.type === 'Identifier') reactive.add(d.id.name);
			}
		} else if (node.type === 'LabeledStatement' && node.label.name === '$') {
			walk(node, {
				enter(n) {
					if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') {
						reactive.add(n.left.name);
					}
				}
			});
		}
	}
	walk(ast.instance, {
		enter(n) { if (n.type === 'Identifier' && n.name.startsWith('$')) reactive.add(n.name); }
	});

	function untracked(name, seen = new Set()) {
		if (seen.has(name)) return new Set();
		seen.add(name);
		const fn = callables.get(name);
		if (!fn) return new Set();
		const out = new Set();
		const bound = new Set((fn.params ?? []).flatMap((p) => [...readsOf(p)]));
		for (const id of readsOf(fn.body ?? fn)) {
			if (bound.has(id)) continue;
			if (reactive.has(id)) out.add(id);
			if (callables.has(id) && id !== name) for (const deep of untracked(id, seen)) out.add(deep);
		}
		return out;
	}

	function check(where, expr) {
		const written = readsOf(expr);
		for (const called of written) {
			if (!callables.has(called)) continue;
			const missing = [...untracked(called)].filter((id) => !written.has(id));
			if (missing.length === 0) continue;
			reported++;
			console.log(`${file}`);
			console.log(`  ${where}: ${called}() leaves ${missing.join(', ')} untracked`);
		}
	}

	if (ast.html) {
		walk(ast.html, {
			enter(n) {
				if (n.type === 'MustacheTag' || n.type === 'IfBlock' ||
					n.type === 'EachBlock' || n.type === 'AttributeShorthand') {
					if (n.expression) check('template', n.expression);
				}
			}
		});
	}
	for (const node of ast.instance.content.body) {
		if (node.type === 'LabeledStatement' && node.label.name === '$') {
			check('reactive statement', node.body);
		}
	}
}

if (reported > 0) {
	console.error(`\n${reported} reactive site(s) with untracked dependencies`);
	process.exit(1);
}
console.log('no frozen reactive sites found');
```

- [ ] **Step 2 : Calibrer sur le défaut connu**

Un détecteur qui ne retrouve pas le défaut documenté ne prouve rien sur ceux qu'il ne signale pas.

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node scripts/svelte-frozen-props.mjs frontend/src/lib/components/GameDetailsModal.svelte
```

Expected — deux sites, sortie 1 :
```
frontend/src/lib/components/GameDetailsModal.svelte
  template: formatDate() leaves $language untracked
frontend/src/lib/components/GameDetailsModal.svelte
  template: formatDate() leaves $language untracked

2 reactive site(s) with untracked dependencies
```

Si la sortie est vide, l'instrument est cassé : ne pas continuer, il rendrait les tâches 8 à 13 invérifiables.

- [ ] **Step 3 : Enregistrer la référence**

Run:
```bash
node scripts/svelte-frozen-props.mjs $(find frontend/src -name '*.svelte' | sort)
```

Expected — exactement six sites, à recopier dans le message de commit :

| Site | Verdict |
|---|---|
| `GameDetailsModal.formatDate` → `$language` (×2) | **réel**, préexistant et connu |
| `RoomPlayers.slotAction` → `$language, isSinglePlayer, currentPlayerPort, $user` (×2) | **réel**, trouvé par cette passe |
| `PlayerControls.startPolling` / `stopPolling` | **bénin** : effets impératifs gardés sur `editing` et `hasPad`, qui sont bien les conditions de déclenchement |

Cette liste est la référence. Les tâches 8 à 13 doivent la laisser inchangée : aucun site nouveau.

- [ ] **Step 4 : Commit** (demander l'accord d'abord)

```bash
git add scripts/svelte-frozen-props.mjs
git commit -m "outil: détecter les expressions réactives gelées par Svelte 4

Un \$: ou une expression de template qui appelle une déclaration de fonction
lisant de l'état réactif compile en initialisation unique, sans erreur ni
avertissement. Le défaut a mordu quatre fois et a échappé à une relecture qui
le cherchait explicitement; la lecture du source ne peut pas le trancher.

Calibré sur GameDetailsModal.formatDate, dont les dates gardent la locale
précédente après un changement de langue. Référence à six sites, dont deux
bénins (PlayerControls, effets impératifs correctement gardés)."
```

---

## Task 2 : Signaler le défaut trouvé dans RoomPlayers

L'instrument a trouvé un défaut réel qui n'était pas connu. Il est **hors périmètre** de cette passe — c'est un changement de comportement — donc il est signalé, pas corrigé.

**Files:**
- Modify: aucun

- [ ] **Step 1 : Vérifier le symptôme dans l'application**

`frontend/src/lib/components/RoomPlayers.svelte:38-39` :

```svelte
$: player1Action = slotAction(1, player1);
$: player2Action = slotAction(2, player2);
```

`slotAction` lit `isSinglePlayer`, `currentPlayerPort`, `$user` et `$language`, dont aucun n'apparaît au site d'appel. Les deux statements ne se réévaluent que quand `player1` ou `player2` changent.

Deux symptômes à confirmer dans le lobby, à deux onglets :
1. changer la langue : les libellés des manettes gardent l'ancienne, alors que tout le reste de l'écran suit ;
2. faire entrer un second joueur : le libellé du port 2 reste celui calculé quand la room était à un joueur.

- [ ] **Step 2 : Rapporter au propriétaire**

Ne pas corriger dans cette passe. Le remède tient en deux lignes et sera un changement à part :

```svelte
$: player1Action = slotAction(1, player1, isSinglePlayer, currentPlayerPort, $user, $language);
$: player2Action = slotAction(2, player2, isSinglePlayer, currentPlayerPort, $user, $language);
```

avec la signature de `slotAction` élargie en conséquence. Demander si le correctif est souhaité maintenant ou plus tard.

---

## Task 3 : `fromBase64` et les six sites réécrits à la main

**Files:**
- Modify: `frontend/src/lib/saves/base64.ts`
- Modify: `core/test/quick-save.test.ts`
- Modify: `frontend/src/lib/components/LockstepRoom.svelte:913,944,959`
- Modify: `frontend/src/lib/components/SoloRoom.svelte:342,392,446`
- Modify: `frontend/src/lib/components/P2PRoom.svelte:280`

**Interfaces:**
- Consumes: `toBase64(bytes: Uint8Array): string`, déjà présent
- Produces: `fromBase64(text: string): Uint8Array`

- [ ] **Step 1 : Écrire le test qui échoue**

Ajouter à `core/test/quick-save.test.ts`. La taille est choisie : c'est au-dessus de 100 000 que la version naïve casse.

```ts
import { toBase64, fromBase64 } from '../../frontend/src/lib/saves/base64.js';

test('a buffer larger than the argument limit survives a round trip', () => {
	// 800KB is a real savestate; 100k arguments is roughly where a spread call
	// blows the stack, so anything above it exercises the chunking.
	const bytes = new Uint8Array(800 * 1024);
	for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;

	const back = fromBase64(toBase64(bytes));

	assert.equal(back.length, bytes.length);
	assert.ok(back.every((b, i) => b === bytes[i]), 'every byte survives');
});

test('an empty buffer round trips to an empty buffer', () => {
	assert.equal(fromBase64(toBase64(new Uint8Array(0))).length, 0);
});
```

- [ ] **Step 2 : Lancer le test pour vérifier qu'il échoue**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/quick-save.test.ts
```
Expected: FAIL — `fromBase64 is not a function` (l'export n'existe pas).

- [ ] **Step 3 : Écrire `fromBase64`**

Ajouter à `frontend/src/lib/saves/base64.ts`, sous `toBase64`. **Aucun import** : c'est ce qui rend ce module atteignable depuis `core/test`, qui tourne sous node nu et ne résout pas l'alias `$lib`.

```ts
/**
 * The inverse of `toBase64`, and the reason four call sites had their own copy.
 *
 * `atob` returns a binary string, so the byte-by-byte walk is unavoidable; what
 * is avoidable is writing it again in every component that loads a save.
 */
export function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
```

- [ ] **Step 4 : Lancer le test pour vérifier qu'il passe**

Run: `node --import tsx --test core/test/quick-save.test.ts`
Expected: PASS.

- [ ] **Step 5 : Remplacer les six sites**

Dans `LockstepRoom.svelte`, ajouter l'import `import { toBase64, fromBase64 } from '$lib/saves/base64';` puis :

- ligne 944, dans `persistSram` — remplacer les cinq lignes de boucle chunkée et le `btoa(binary)` par :
  ```ts
  $socket.emit('game:saveSram', { roomId, sramData: toBase64(sram) });
  ```
- ligne 913 (`const binary = atob(payload.sramData)` et la boucle qui suit) et ligne 959 (idem pour `payload.saveData`) — remplacer par `const bytes = fromBase64(payload.sramData)` / `fromBase64(payload.saveData)` et supprimer la boucle de décodage devenue morte.

Dans `SoloRoom.svelte`, même import, puis :

- ligne 446, dans `persistSram` — la boucle octet par octet `for (let i = 0; i < sram.length; i++) binary += String.fromCharCode(sram[i]);` devient `toBase64(sram)` ;
- lignes 342 et 392 — les deux boucles `atob` deviennent `fromBase64(...)`.

Dans `P2PRoom.svelte` ligne 280 — **seul changement de comportement de la passe** :

```ts
// avant : String.fromCharCode(...Array.from(uint8Array)) sur le SRAM entier,
// qui est exactement le débordement de pile que toBase64 existe pour empêcher.
const sramData = toBase64(uint8Array);
```
et ligne 230, `atob(data.sramData)` et sa boucle deviennent `fromBase64(data.sramData)`.

- [ ] **Step 6 : Vérifier**

Run:
```bash
node --import tsx --test core/test/quick-save.test.ts core/test/saves-api.test.ts core/test/resume-save.test.ts
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -5
```
Expected: tests PASS, aucune nouvelle erreur `svelte-check`.

Vérifier qu'il ne reste aucun encodage à la main :
```bash
grep -rn "fromCharCode\|atob(\|btoa(" frontend/src --include='*.svelte' --include='*.ts' | grep -v 'saves/base64.ts'
```
Expected: aucune sortie.

- [ ] **Step 7 : Commit** (demander l'accord d'abord)

```bash
git add frontend/src/lib/saves/base64.ts core/test/quick-save.test.ts \
        frontend/src/lib/components/LockstepRoom.svelte \
        frontend/src/lib/components/SoloRoom.svelte \
        frontend/src/lib/components/P2PRoom.svelte
git commit -m "Donner à base64 son inverse, et retirer les quatre copies

toBase64 existait, testé, avec un en-tête expliquant le débordement de pile
qu'il évite. Quatre sites l'ignoraient et réécrivaient l'encodage, dont deux
avec exactement ce défaut: P2PRoom spreadait le SRAM entier, SoloRoom
construisait une chaîne de 800Ko caractère par caractère.

fromBase64 manquait, donc quatre sites réécrivaient aussi le décodage."
```

---

## Task 4 : Supprimer les dix fichiers injoignables

**Files:**
- Delete: les dix ci-dessous

- [ ] **Step 1 : Reconfirmer l'injoignabilité avant de supprimer**

L'analyse date ; l'arbre a bougé aux tâches 1 à 3. Revérifier plutôt que faire confiance.

```bash
for f in components/GameCanvas emulator/performance-monitor emulator/network-detector \
         emulator/input-buffer emulator/input-predictor emulator/audio-capture \
         emulator/sync-manager config/socketEvents services/latency config/keyConfig; do
  echo "-- $f"
  grep -rn "lib/$f['\"]" frontend/src core e2e backend 2>/dev/null
  grep -rnE "from ['\"]\./$(basename $f)['\"]" frontend/src core e2e 2>/dev/null
done
```
Expected: aucune sortie pour aucun des dix.

Deux pièges déjà écartés, à ne pas ré-attraper : `frontend/src/lib/polyfills.ts` est vivant (`import '$lib/polyfills'`, sans clause `from`, invisible à une recherche de `from '...'`) et `backend/src/db/migrate-cli.ts` est vivant (`docker-compose.yml:28`). Ni l'un ni l'autre n'est dans la liste.

- [ ] **Step 2 : Supprimer**

```bash
git rm frontend/src/lib/components/GameCanvas.svelte \
       frontend/src/lib/emulator/performance-monitor.ts \
       frontend/src/lib/emulator/network-detector.ts \
       frontend/src/lib/emulator/input-buffer.ts \
       frontend/src/lib/emulator/input-predictor.ts \
       frontend/src/lib/emulator/audio-capture.ts \
       frontend/src/lib/emulator/sync-manager.ts \
       frontend/src/lib/config/socketEvents.ts \
       frontend/src/lib/services/latency.ts \
       frontend/src/lib/config/keyConfig.ts
```

`frontend/src/lib/netplay/input-buffer.ts` **reste** : c'est un fichier distinct, atteint via `netplay/index.ts`. Ne pas confondre les deux.

- [ ] **Step 3 : Vérifier que rien ne cassait dessus**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -5 && npm run build 2>&1 | tail -5
cd .. && npm run test:all
```
Expected: build réussi, aucune nouvelle erreur, toutes les suites vertes.

Une erreur de compilation ici signifie que le graphe a été mal lu : revérifier le fichier concerné plutôt que restaurer les dix.

- [ ] **Step 4 : Commit** (demander l'accord d'abord)

```bash
git commit -m "Supprimer dix modules qu'aucune route n'atteint

1780 lignes: le reste du chemin de streaming d'avant le netcode lockstep,
plus deux modules de configuration qu'aucun import ne nomme. Établi par
parcours du graphe depuis src/routes et le service worker, puis reconfirmé
fichier par fichier par recherche du chemin d'import exact.

netplay/input-buffer.ts reste: c'est un autre fichier, et il est atteint."
```

---

## Task 5 : Extraire `PadTimeline`

**Files:**
- Create: `frontend/src/lib/znet/pad-timeline.ts`
- Create: `core/test/pad-timeline.test.ts`
- Modify: `frontend/src/lib/znet/session.ts`
- Modify: `package.json` (script `test:netplay`)

**Interfaces:**
- Consumes: `PadMask` depuis `./protocol.js`
- Produces:
  ```ts
  export const PLAYER_COUNT = 2;
  export class PadTimeline {
    get baseFrame(): number;
    reset(from: number, inputDelay: number): void;
    has(player: number, frame: number): boolean;
    hasAll(frame: number): boolean;
    get(player: number, frame: number): PadMask | undefined;
    set(player: number, frame: number, pad: PadMask): void;
    newestAtOrBelow(player: number, frame: number, floor: number): PadMask;
    fillGap(player: number, from: number, upTo: number, pad: PadMask): void;
    runEndingAt(player: number, from: number, upTo: number):
      { baseFrame: number; pads: PadMask[] } | null;
    padsAhead(frame: number): number[];
    setLocalCrc(frame: number, crc: number): void;
    getLocalCrc(frame: number): number | undefined;
    setRemoteCrc(frame: number, crc: number): void;
    getRemoteCrc(frame: number): number | undefined;
    prune(cutoff: number): void;
  }
  ```

- [ ] **Step 1 : Écrire les tests qui échouent**

`core/test/pad-timeline.test.ts`. Ces trois cas encodent des défauts que la session a réellement eus — chacun a coûté un blocage en production.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { PadTimeline } from '../../frontend/src/lib/znet/pad-timeline.js';

test('a run stops at a hole rather than shipping across it', () => {
	// A gap means history was pruned. Shipping across it would mislabel every
	// pad after the hole by the width of the hole, which is a silent desync.
	const t = new PadTimeline();
	t.reset(0, 0);
	t.set(0, 10, 0x01);
	// 11 deliberately absent
	t.set(0, 12, 0x02);
	t.set(0, 13, 0x04);

	const run = t.runEndingAt(0, 10, 13);

	assert.deepEqual(run, { baseFrame: 12, pads: [0x02, 0x04] });
});

test('filling a raise gap leaves no frame behind', () => {
	// tick() only ever fills frame + delay, one entry per executed frame. Push
	// the horizon out and the frames in between are skipped for good unless
	// something fills them: the peer then waits on a pad nobody will send.
	const t = new PadTimeline();
	t.reset(0, 0);
	t.set(0, 100, 0x08);

	t.fillGap(0, 100, 104, t.newestAtOrBelow(0, 100, 0));

	for (let f = 100; f <= 104; f++) {
		assert.equal(t.get(0, f), 0x08, `frame ${f} is filled`);
	}
});

test('filling never overwrites a pad already held', () => {
	const t = new PadTimeline();
	t.reset(0, 0);
	t.set(0, 100, 0x08);
	t.set(0, 102, 0x10);

	t.fillGap(0, 100, 104, 0x08);

	assert.equal(t.get(0, 102), 0x10, 'the real pad wins over the repeat');
});

test('the startup window is primed for both players', () => {
	// Nobody can have sent a pad for the first D frames: their input would have
	// been sampled before the session existed. Both peers fill them with zero,
	// the one value they are guaranteed to agree on.
	const t = new PadTimeline();
	t.reset(500, 3);

	for (let f = 500; f < 503; f++) assert.ok(t.hasAll(f), `frame ${f} primed`);
	assert.equal(t.hasAll(503), false, 'and no further');
});

test('padsAhead counts the contiguous reserve, not the total held', () => {
	const t = new PadTimeline();
	t.reset(0, 0);
	t.set(0, 10, 0); t.set(0, 11, 0); t.set(0, 13, 0);
	t.set(1, 10, 0);

	assert.deepEqual(t.padsAhead(10), [2, 1]);
});

test('pruning clears pads and both checksum sides together', () => {
	const t = new PadTimeline();
	t.reset(0, 0);
	t.set(0, 5, 0x01);
	t.setLocalCrc(5, 0xaaaa);
	t.setRemoteCrc(5, 0xbbbb);
	t.set(0, 50, 0x02);

	t.prune(20);

	assert.equal(t.get(0, 5), undefined);
	assert.equal(t.getLocalCrc(5), undefined);
	assert.equal(t.getRemoteCrc(5), undefined);
	assert.equal(t.get(0, 50), 0x02, 'what is past the cutoff stays');
});
```

- [ ] **Step 2 : Lancer les tests pour vérifier qu'ils échouent**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/pad-timeline.test.ts
```
Expected: FAIL — le module n'existe pas.

- [ ] **Step 3 : Écrire `pad-timeline.ts`**

Le corps de chaque méthode vient de `session.ts` : `hasAllPads` (1109-1114), la boucle de `sendPadRange` (1120-1133), `primeStartupPads` (1153-1160), `pruneHistory` (1161-1174), la boucle de recherche du dernier pad dans `setDelay` (611-620), et la carte `padsAhead` de `getStats` (635-639).

```ts
/**
 * The two players' pads and checksums, keyed by absolute frame.
 *
 * Extracted from NetplaySession because it is the half of the engine that
 * decides nothing: it holds what has been sampled and what has arrived, and
 * answers questions about it. Everything that talks to the transport, and every
 * decision about what to do when a pad is missing, stayed in the session.
 *
 * The frame numbers are absolute and shared by both peers, which is what lets a
 * pad packet be applied without knowing when it was sent.
 */
import type { PadMask } from './protocol.js';

export const PLAYER_COUNT = 2;

export class PadTimeline {
	private pads: Array<Map<number, PadMask>> = [new Map(), new Map()];
	private localCrcs = new Map<number, number>();
	private remoteCrcs = new Map<number, number>();
	private _baseFrame = 0;

	get baseFrame(): number {
		return this._baseFrame;
	}

	/**
	 * Starts a fresh timeline at `from`, with the first `inputDelay` frames
	 * primed to neutral for both players.
	 *
	 * Nobody can have sent a pad for those frames: their input would have been
	 * sampled before the epoch existed. Zero is the one value both peers are
	 * guaranteed to agree on.
	 */
	reset(from: number, inputDelay: number): void {
		this.pads = [new Map(), new Map()];
		this.localCrcs.clear();
		this.remoteCrcs.clear();
		this._baseFrame = from;
		for (let p = 0; p < PLAYER_COUNT; p++) {
			for (let f = from; f < from + inputDelay; f++) this.pads[p].set(f, 0);
		}
	}

	has(player: number, frame: number): boolean {
		return this.pads[player].has(frame);
	}

	hasAll(frame: number): boolean {
		for (let p = 0; p < PLAYER_COUNT; p++) if (!this.pads[p].has(frame)) return false;
		return true;
	}

	get(player: number, frame: number): PadMask | undefined {
		return this.pads[player].get(frame);
	}

	set(player: number, frame: number, pad: PadMask): void {
		this.pads[player].set(frame, pad);
	}

	/** The newest pad at or below `frame`, searching down to `floor`. 0 if none. */
	newestAtOrBelow(player: number, frame: number, floor: number): PadMask {
		for (let f = frame; f >= floor; f--) {
			const held = this.pads[player].get(f);
			if (held !== undefined) return held;
		}
		return 0;
	}

	/** Repeats `pad` across [from..upTo], never overwriting a real entry. */
	fillGap(player: number, from: number, upTo: number, pad: PadMask): void {
		for (let f = from; f <= upTo; f++) {
			if (!this.pads[player].has(f)) this.pads[player].set(f, pad);
		}
	}

	/**
	 * The contiguous run of `player`'s pads ending at `upTo`.
	 *
	 * A hole means history was pruned, and a run must not span one: the
	 * receiver reads the pads as consecutive from `baseFrame`, so shipping
	 * across a gap would shift every pad after it.
	 */
	runEndingAt(
		player: number,
		from: number,
		upTo: number
	): { baseFrame: number; pads: PadMask[] } | null {
		const first = Math.max(this._baseFrame, from);
		let run: PadMask[] = [];
		for (let f = first; f <= upTo; f++) {
			const pad = this.pads[player].get(f);
			if (pad === undefined) {
				run = [];
				continue;
			}
			run.push(pad);
		}
		if (run.length === 0) return null;
		return { baseFrame: upTo - run.length + 1, pads: run };
	}

	/** Frames of reserve held beyond `frame`, per player. */
	padsAhead(frame: number): number[] {
		return this.pads.map((map) => {
			let ahead = 0;
			while (map.has(frame + ahead)) ahead++;
			return ahead;
		});
	}

	setLocalCrc(frame: number, crc: number): void {
		this.localCrcs.set(frame, crc);
	}
	getLocalCrc(frame: number): number | undefined {
		return this.localCrcs.get(frame);
	}
	setRemoteCrc(frame: number, crc: number): void {
		this.remoteCrcs.set(frame, crc);
	}
	getRemoteCrc(frame: number): number | undefined {
		return this.remoteCrcs.get(frame);
	}

	/** Drops everything below `cutoff`. Pads and both checksum sides together. */
	prune(cutoff: number): void {
		if (cutoff <= this._baseFrame) return;
		for (let p = 0; p < PLAYER_COUNT; p++) {
			for (const f of this.pads[p].keys()) if (f < cutoff) this.pads[p].delete(f);
		}
		for (const f of this.localCrcs.keys()) if (f < cutoff) this.localCrcs.delete(f);
		for (const f of this.remoteCrcs.keys()) if (f < cutoff) this.remoteCrcs.delete(f);
	}
}
```

- [ ] **Step 4 : Lancer les tests pour vérifier qu'ils passent**

Run: `node --import tsx --test core/test/pad-timeline.test.ts`
Expected: PASS, six tests.

- [ ] **Step 5 : Câbler dans `session.ts`**

Remplacer les champs `pads`, `localCrcs`, `remoteCrcs`, `baseFrame` par `private timeline = new PadTimeline();`, importer `PadTimeline` et `PLAYER_COUNT` depuis `./pad-timeline.js`, et supprimer la constante `PLAYER_COUNT` locale (ligne 148).

Supprimer les méthodes `hasAllPads`, `primeStartupPads`, `pruneHistory` et remplacer leurs appels :

| Avant | Après |
|---|---|
| `this.pads[p].has(f)` / `.get(f)` / `.set(f, v)` | `this.timeline.has(p, f)` / `.get(p, f)` / `.set(p, f, v)` |
| `this.hasAllPads(this.frame)` | `this.timeline.hasAll(this.frame)` |
| `this.primeStartupPads(from)` | plié dans `this.timeline.reset(from, this.opts.inputDelay)` |
| `this.pruneHistory()` | `this.timeline.prune(this.frame - Math.max(120, this.epochMaxDelay * 4))` |
| `this.baseFrame` | `this.timeline.baseFrame` |
| `this.localCrcs` / `this.remoteCrcs` | `this.timeline.setLocalCrc(...)` etc. |

Dans `sendPadRange`, la boucle devient :
```ts
const run = this.timeline.runEndingAt(this.playerIndex, from, upTo);
if (!run) return;
this.send({
	type: MsgType.Pads,
	playerIndex: this.playerIndex,
	epoch: this.epoch,
	baseFrame: run.baseFrame,
	strain: this.lateCount,
	pads: run.pads
});
```

Dans `setDelay`, la recherche du dernier pad et le remplissage deviennent :
```ts
const last = this.timeline.newestAtOrBelow(this.playerIndex, this.frame + previous, this.frame);
this.timeline.fillGap(this.playerIndex, this.frame + previous, this.frame + frames, last);
this.sendPadRange(this.frame + previous, this.frame + frames);
```

Dans `getStats`, `padsAhead` devient `this.timeline.padsAhead(this.frame)`.

Dans `resetTimeline`, l'affectation de `baseFrame` et la remise à zéro des cartes deviennent un seul `this.timeline.reset(from, this.opts.inputDelay)`. Vérifier en lisant `resetTimeline` (1237-1267) que l'ordre est conservé : le `reset` doit venir là où les cartes étaient vidées, avant tout `set` qui suit.

- [ ] **Step 6 : Vérifier que la session est intacte**

Run:
```bash
npm run test:netplay && npm run test:core
```
Expected: les 57 tests de `netcode.test.ts` PASS, plus `relay`, `determinism`, `lockstep`. Aucune assertion modifiée.

C'est le contrôle qui compte : ces tests couvrent nommément le rebouchage de trou (« raising the delay leaves no hole in our own pads, at any phase ») et la fenêtre de re-émission (« an outage recovers even when the redundancy window is shorter than the input delay »).

- [ ] **Step 7 : Ajouter la suite au script**

Dans `package.json`, `test:netplay` devient :
```
"test:netplay": "node --import tsx --test core/test/netcode.test.ts core/test/relay.test.ts core/test/pad-timeline.test.ts"
```

- [ ] **Step 8 : Commit** (demander l'accord d'abord)

```bash
git add frontend/src/lib/znet/pad-timeline.ts core/test/pad-timeline.test.ts \
        frontend/src/lib/znet/session.ts package.json
git commit -m "Sortir la timeline de pads de NetplaySession

La moitié du moteur qui ne décide rien: ce qui a été échantillonné, ce qui est
arrivé, et les questions qu'on pose là-dessus. Tout ce qui touche au transport
et toute décision sur un pad manquant restent dans la session.

Le rebouchage de trou et l'arrêt d'un run sur une lacune sont maintenant
testables directement; ils n'étaient atteignables qu'en pilotant une session
entière, et chacun a coûté un blocage en production."
```

---

## Task 6 : Extraire `LinkMetrics`

**Files:**
- Create: `frontend/src/lib/znet/link-metrics.ts`
- Create: `core/test/link-metrics.test.ts`
- Modify: `frontend/src/lib/znet/session.ts`, `package.json`

**Interfaces:**
- Consumes: rien
- Produces:
  ```ts
  export class LinkMetrics {
    constructor(fps: number);
    setFps(fps: number): void;
    get rtt(): number | null;
    get jitter(): number | null;
    get strain(): number;
    get peerStrain(): number;
    notePingSent(id: number, at: number): void;
    notePingReply(id: number, at: number): number | null;
    samplePadArrival(newestFrame: number, at: number): void;
    noteFrameRun(at: number): void;
    notePeerStrain(strain: number): void;
    resetFrameTiming(): void;
  }
  ```

- [ ] **Step 1 : Écrire les tests qui échouent**

`core/test/link-metrics.test.ts` :

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkMetrics } from '../../frontend/src/lib/znet/link-metrics.js';

const NTSC = 60.0988;

test('jitter is measured against the machine cadence, not the wall clock', () => {
	// The sender emits one packet per frame it runs, so the frames between two
	// packets are the intended gap. Assuming 60 flat on a PAL session makes
	// every packet look 3.36ms late and reports a steady link as jittery.
	const m = new LinkMetrics(NTSC);
	const frameMs = 1000 / NTSC;

	m.samplePadArrival(100, 0);
	m.samplePadArrival(101, frameMs);
	m.samplePadArrival(102, frameMs * 2);

	assert.ok((m.jitter ?? 1) < 0.01, `a perfectly cadenced link reads calm, got ${m.jitter}`);
});

test('jitter is unknown until pads are actually flowing', () => {
	const m = new LinkMetrics(NTSC);
	assert.equal(m.jitter, null);
	m.samplePadArrival(100, 0);
	assert.equal(m.jitter, null, 'one arrival is not a spacing');
});

test('a reordered packet does not move the figure much', () => {
	// RFC 3550 smoothing, gain 1/16: slow enough to ignore one bad packet,
	// quick enough to follow a route that changes.
	const m = new LinkMetrics(NTSC);
	const frameMs = 1000 / NTSC;
	for (let i = 0; i < 20; i++) m.samplePadArrival(100 + i, frameMs * i);
	const calm = m.jitter ?? 0;

	m.samplePadArrival(119, frameMs * 19);   // older frame, must be ignored
	assert.equal(m.jitter, calm, 'a frame at or below the newest is not a sample');
});

test('a round trip is measured only for a ping that was sent', () => {
	const m = new LinkMetrics(NTSC);
	m.notePingSent(1, 1000);

	assert.equal(m.notePingReply(2, 1050), null, 'an unknown id is not a sample');
	assert.equal(m.notePingReply(1, 1050), 50);
	assert.equal(m.rtt, 50);
	assert.equal(m.notePingReply(1, 1100), null, 'and it is consumed');
});

test('late frames are counted over a sliding window', () => {
	// A gap this much wider than the machine's own is a stutter a player sees.
	const m = new LinkMetrics(NTSC);
	const frameMs = 1000 / NTSC;
	let at = 0;
	m.noteFrameRun(at);
	for (let i = 0; i < 10; i++) { at += frameMs; m.noteFrameRun(at); }
	assert.equal(m.strain, 0, 'a machine on cadence has no strain');

	for (let i = 0; i < 5; i++) { at += frameMs * 3; m.noteFrameRun(at); }
	assert.equal(m.strain, 5, 'and five stutters read as five');
});

test('the peer strain is recorded even when nothing will act on it', () => {
	const m = new LinkMetrics(NTSC);
	m.notePeerStrain(27);
	assert.equal(m.peerStrain, 27);
});
```

- [ ] **Step 2 : Lancer pour vérifier l'échec**

Run: `node --import tsx --test core/test/link-metrics.test.ts`
Expected: FAIL — le module n'existe pas.

- [ ] **Step 3 : Écrire `link-metrics.ts`**

Les corps viennent de `session.ts` : `sampleJitter` (960-978), `noteFrameTiming` (979-1005), les champs `pendingPings`/`nextPingId`/`_rtt` (418-420), `_jitter`/`lastPadArrival` (433-435), l'anneau `lateRing`/`lateAt`/`lateCount`/`lastFrameAt` (412-415), `_peerStrain` (403), et les constantes `STRAIN_WINDOW` (128) et `LATE_FACTOR` (1.5).

```ts
/**
 * What the link is doing, measured. Decides nothing.
 *
 * Extracted from NetplaySession so that the numbers the delay loop reacts to
 * can be exercised without driving a whole session: a loop whose input is only
 * reachable through ten seconds of simulated network cannot be told apart from
 * a loop that is broken.
 *
 * Every method takes the current time as a parameter rather than reading a
 * clock, for the same reason the session does: the tests drive entire sessions
 * through a virtual clock at full CPU speed.
 */

/** Window over which late frames are counted, and reported to the peer. */
const STRAIN_WINDOW = 128;

/**
 * A frame gap this much wider than the machine's own is a stutter a player
 * sees. The same threshold the offline instrument uses, so the two agree.
 */
const LATE_FACTOR = 1.5;

export class LinkMetrics {
	private fps: number;

	private pendingPings = new Map<number, number>();
	private _rtt: number | null = null;

	private _jitter: number | null = null;
	private lastPadArrival: { at: number; frame: number } | null = null;

	private lateRing = new Uint8Array(STRAIN_WINDOW);
	private lateAt = 0;
	private lateCount = 0;
	private lastFrameAt: number | null = null;

	private _peerStrain = 0;

	constructor(fps: number) {
		this.fps = fps;
	}

	setFps(fps: number): void {
		this.fps = fps;
	}

	get rtt(): number | null {
		return this._rtt;
	}
	get jitter(): number | null {
		return this._jitter;
	}
	/** Our own late frames over the last 128. Zero is the healthy figure. */
	get strain(): number {
		return this.lateCount;
	}
	get peerStrain(): number {
		return this._peerStrain;
	}

	notePingSent(id: number, at: number): void {
		this.pendingPings.set(id, at);
	}

	/** The round trip for `id`, or null if it was never sent or already answered. */
	notePingReply(id: number, at: number): number | null {
		const sentAt = this.pendingPings.get(id);
		if (sentAt === undefined) return null;
		this.pendingPings.delete(id);
		this._rtt = at - sentAt;
		return this._rtt;
	}

	/**
	 * Notes when the peer's newest pad arrived, and updates the jitter estimate.
	 *
	 * Jitter, not latency, is the number that decides the input delay: latency
	 * costs a one-off offset between the peers, while it is the *variation* that
	 * leaves a pad late for the frame that needed it.
	 */
	samplePadArrival(newestFrame: number, at: number): void {
		const previous = this.lastPadArrival;
		if (previous === null || newestFrame <= previous.frame) {
			if (previous === null) this.lastPadArrival = { at, frame: newestFrame };
			return;
		}
		// What the spacing should have been: the sender emits one packet per
		// frame it runs, so the frames between the two packets are the gap.
		const expected = ((newestFrame - previous.frame) * 1000) / this.fps;
		const drift = Math.abs(at - previous.at - expected);
		// RFC 3550's smoothing, gain 1/16: slow enough that one reordered packet
		// does not move the figure, quick enough to follow a route that changes.
		this._jitter = this._jitter === null ? drift : this._jitter + (drift - this._jitter) / 16;
		this.lastPadArrival = { at, frame: newestFrame };
	}

	/** Notes whether the frame about to run is arriving late. */
	noteFrameRun(at: number): void {
		const previous = this.lastFrameAt;
		this.lastFrameAt = at;
		if (previous === null) return;
		const late = at - previous > (1000 / this.fps) * LATE_FACTOR ? 1 : 0;
		this.lateCount += late - this.lateRing[this.lateAt];
		this.lateRing[this.lateAt] = late;
		this.lateAt = (this.lateAt + 1) % STRAIN_WINDOW;
	}

	notePeerStrain(strain: number): void {
		this._peerStrain = strain;
	}

	/** Forgets the last frame time, so a resync does not read as one long stutter. */
	resetFrameTiming(): void {
		this.lastFrameAt = null;
	}
}
```

- [ ] **Step 4 : Lancer pour vérifier le passage**

Run: `node --import tsx --test core/test/link-metrics.test.ts`
Expected: PASS, six tests.

- [ ] **Step 5 : Câbler dans `session.ts`**

Remplacer les neuf champs listés à l'étape 3 par `private metrics: LinkMetrics;`, construit après `this.opts` (il a besoin de `this.opts.fps`) : `this.metrics = new LinkMetrics(this.opts.fps);`.

- `sampleJitter` et `noteFrameTiming` sont supprimées ; leurs appels deviennent `this.metrics.samplePadArrival(newestFrame, this.now())` et `this.metrics.noteFrameRun(this.now())`.
- `ping()` : `this.metrics.notePingSent(id, this.now())` à la place du `pendingPings.set`.
- La branche `Pong` de `handleMessage` : `this.metrics.notePingReply(id, this.now())`, et **conserver le comportement actuel sur un id inconnu** — relire les lignes 1295-1344 pour voir si le code actuel ignore ou traite ; reproduire à l'identique.
- Les accès `this.lateCount` (dans `sendPadRange` et `getStats`) deviennent `this.metrics.strain`.
- `this._peerStrain` devient `this.metrics.peerStrain`, et son affectation en tête de `notePeerStrain` devient `this.metrics.notePeerStrain(strain)`.
- Les accesseurs publics `get rtt()` et `get jitter()` renvoient `this.metrics.rtt` / `this.metrics.jitter` — **la surface publique ne change pas**.
- `getStats` lit `rtt`, `jitter`, `strain`, `peerStrain` depuis `this.metrics`.

- [ ] **Step 6 : Vérifier**

Run: `npm run test:netplay && npm run test:core`
Expected: tout vert. Surveiller en particulier « the reported jitter tells a calm link from a nervous one », « jitter is measured against the machine cadence, not an assumed one » et « measured RTT tracks the link ».

- [ ] **Step 7 : Ajouter la suite à `test:netplay`** (ajouter `core/test/link-metrics.test.ts`)

- [ ] **Step 8 : Commit** (demander l'accord d'abord)

```bash
git add frontend/src/lib/znet/link-metrics.ts core/test/link-metrics.test.ts \
        frontend/src/lib/znet/session.ts package.json
git commit -m "Sortir les mesures de lien de NetplaySession

RTT, gigue, frames tardives, tension du pair. Neuf champs et deux méthodes qui
mesurent et ne décident rien.

Ces nombres sont l'entrée de la boucle de délai. Ils n'étaient atteignables
qu'en pilotant dix secondes de réseau simulé, ce qui rend une boucle cassée
indistinguable d'une boucle dont l'entrée est fausse."
```

---

## Task 7 : Extraire `DelayController`

La tâche la plus délicate du chantier 2 : elle sépare une décision d'une application qui étaient écrites ensemble.

**Files:**
- Create: `frontend/src/lib/znet/delay-control.ts`
- Create: `core/test/delay-control.test.ts`
- Modify: `frontend/src/lib/znet/session.ts`, `package.json`

**Interfaces:**
- Consumes: rien
- Produces:
  ```ts
  export const MIN_INPUT_DELAY = 3;
  export const MIN_AUTO_DELAY = 2;
  export const MIN_MANUAL_DELAY = 1;
  export const MAX_INPUT_DELAY = 16;
  export const DEFAULT_FPS = 60.0988;
  export const DEFAULT_HUNGER_SECONDS = 10;
  export const SIZING_SAMPLES = 5;
  export const SIZING_PING_GAP_MS = 60;
  export const SIZING_BUDGET_MS = 700;

  export function suggestInputDelay(samples: number[] | number, fps?: number): number;

  export type DelayVerdict = { delta: -1 | 1; reason: string } | null;

  export class DelayController {
    constructor(opts: { fps: number; hungerSeconds: number; automatic: boolean });
    get automatic(): boolean;
    pin(): void;
    resumeAutomatic(): void;
    /** Decides whether the delay should move. Applying it is the caller's job. */
    observePeerStrain(strain: number, current: number, nowMs: number): DelayVerdict;
    resetWindow(): void;
    noteSizingPing(): void;
    addSizingSample(rtt: number): void;
    get sizingPings(): number;
    get sizingSamples(): readonly number[];
    sizingVerdict(startedAt: number, nowMs: number): 'wait' | 'ship';
    sizedDelay(): number | null;
  }
  ```

- [ ] **Step 1 : Écrire les tests qui échouent**

`core/test/delay-control.test.ts`. L'hystérésis asymétrique est le comportement le plus coûteux à reconstruire si on le casse : dix secondes tendues pour prendre une frame, trente secondes propres pour en rendre une.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	DelayController,
	suggestInputDelay,
	MIN_INPUT_DELAY,
	MAX_INPUT_DELAY
} from '../../frontend/src/lib/znet/delay-control.js';

const NTSC = 60.0988;
const auto = () => new DelayController({ fps: NTSC, hungerSeconds: 10, automatic: true });

test('the estimator discards the warm-up outlier before measuring spread', () => {
	// A session's first round trip carries the socket, TLS and the relay's route
	// cache all waking up. It reads far above the link and never repeats.
	const withOutlier = suggestInputDelay([40, 42, 41, 43, 300], NTSC);
	const without = suggestInputDelay([40, 42, 41, 43], NTSC);
	assert.equal(withOutlier, without);
});

test('two slow samples are a slow link, not two outliers', () => {
	assert.ok(suggestInputDelay([40, 42, 41, 300, 310], NTSC) > suggestInputDelay([40, 42, 41, 43], NTSC));
});

test('the estimate never leaves its bounds', () => {
	assert.equal(suggestInputDelay([1, 1, 1, 1, 1], NTSC), MIN_INPUT_DELAY);
	assert.equal(suggestInputDelay([5000, 5000, 5000, 5000, 5000], NTSC), MAX_INPUT_DELAY);
	assert.equal(suggestInputDelay([], NTSC), MIN_INPUT_DELAY);
});

test('one rough patch costs nothing', () => {
	// Strain arrives fifty times a second. Counting packets rather than seconds
	// let a single three-second burst buy a permanent frame.
	const c = auto();
	for (let ms = 0; ms < 3000; ms += 20) {
		assert.equal(c.observePeerStrain(27, 5, ms), null, `no verdict at ${ms}ms`);
	}
});

test('ten strained seconds inside the window earn a frame', () => {
	const c = auto();
	let verdict = null;
	for (let s = 0; s < 12 && !verdict; s++) verdict = c.observePeerStrain(27, 5, s * 1000);
	assert.deepEqual(verdict?.delta, 1);
});

test('a clean window gives a frame back, and needs three times the evidence', () => {
	// Quick to protect the other player, slow to reclaim latency for this one.
	const c = auto();
	let down = null;
	for (let s = 0; s < 40 && !down; s++) down = c.observePeerStrain(0, 5, s * 1000);
	assert.equal(down?.delta, -1);
	assert.ok(down !== null);
});

test('the automatic floor is respected on the way down', () => {
	const c = auto();
	let verdict = null;
	for (let s = 0; s < 40 && !verdict; s++) verdict = c.observePeerStrain(0, 2, s * 1000);
	assert.equal(verdict, null, 'two frames is the floor the loop may walk to');
});

test('the ceiling is respected on the way up', () => {
	const c = auto();
	let verdict = null;
	for (let s = 0; s < 20 && !verdict; s++) verdict = c.observePeerStrain(27, MAX_INPUT_DELAY, s * 1000);
	assert.equal(verdict, null);
});

test('a pinned delay is never moved behind the player\'s back', () => {
	const c = auto();
	c.pin();
	let verdict = null;
	for (let s = 0; s < 40 && !verdict; s++) verdict = c.observePeerStrain(27, 5, s * 1000);
	assert.equal(verdict, null);
});

test('handing control back starts the evidence fresh', () => {
	// What the link did while nobody was acting on it must not spend a frame the
	// instant control returns.
	const c = auto();
	for (let s = 0; s < 9; s++) c.observePeerStrain(27, 5, s * 1000);
	c.pin();
	c.resumeAutomatic();
	assert.equal(c.observePeerStrain(27, 5, 9000), null, 'the nine strained seconds are gone');
});

test('a gap longer than the window clears it instead of replaying it', () => {
	// A stall or a backgrounded tab must not read as thirty strained seconds.
	const c = auto();
	for (let s = 0; s < 9; s++) c.observePeerStrain(27, 5, s * 1000);
	assert.equal(c.observePeerStrain(27, 5, 120_000), null);
});
```

- [ ] **Step 2 : Lancer pour vérifier l'échec**

Run: `node --import tsx --test core/test/delay-control.test.ts`
Expected: FAIL — le module n'existe pas.

- [ ] **Step 3 : Écrire `delay-control.ts`**

Déplacer depuis `session.ts` : les constantes des lignes 153-234, `suggestInputDelay` (255-280), la comptabilité de fenêtre et les deux branches de décision de `notePeerStrain` (1006-1102), `resetStrainWindow` (1103-1108), et les champs de calibrage `sizingSince`/`sizingSamples`/`sizingPings` (441-446) et `autoInputDelay` (447).

**La frontière.** `setDelay` reste dans `session.ts` : il rebouche le trou dans la timeline et réémet, ce qui exige la timeline et le transport. Le contrôleur renvoie un verdict, il n'applique rien. C'est la correction faite au design après lecture du code.

Reprendre les commentaires d'origine mot pour mot : ils portent les mesures qui justifient chaque seuil (« un lien réel a eu une mauvaise passe, la boucle a payé des frames, le lien a récupéré et les frames sont restées — huit, 160ms »). **Corriger en revanche l'en-tête de `notePeerStrain`**, qui affirme « One-way on purpose — it only ever raises » alors que le corps redescend : c'est un vestige d'avant l'ajout de la descente.

```ts
/**
 * The input-delay policy, and nothing else.
 *
 * Decides; never applies. Raising the delay leaves a hole in the pad timeline
 * that has to be filled and reshipped, which needs the timeline and the
 * transport - so the session keeps `setDelay` and this returns a verdict.
 *
 * Two mechanisms live here. The handshake sizes the delay once from a burst of
 * round trips, and thereafter a slow loop walks it up when the peer reports
 * losing frames and back down when the link has been quiet for a full window.
 */

/**
 * Floor for the *estimate*, which is a guess and has to be a cautious one.
 *
 * It comes from five pings over 300ms, and that burst under-reads this relay:
 * one session measured 66ms while sizing and then ran at a median of 81ms.
 * Being a frame too tight costs the *other* player stutter, so the handshake
 * starts no lower than three whatever it thinks it saw. The loop may go lower
 * than this, but only on evidence - see MIN_AUTO_DELAY.
 */
export const MIN_INPUT_DELAY = 3;

/**
 * Floor for where the loop may *walk* the delay, which is a measurement.
 *
 * Two frames is reachable and correct on a good link: a real pair on a 52ms
 * relay path played at two each with strain at zero on both sides, and their
 * own verdict was that it was the best the game had felt. Thirty consecutive
 * seconds without a single late frame is a far better reason to sit at two than
 * a handshake's opinion, and if it turns out wrong the loop takes the frame back
 * within ten strained seconds.
 */
export const MIN_AUTO_DELAY = 2;

/**
 * Floor for a delay someone set on purpose.
 *
 * Because the requirement is on the sum, a peer can sit well under the
 * automatic floor as long as its partner sits above: on a 90ms round trip a
 * 1/5 split runs with exactly as few stalls as 3/3 and the player on the short
 * end feels 17ms instead of 50. Zero is not offered - with no lead at all every
 * frame waits a full one-way trip.
 */
export const MIN_MANUAL_DELAY = 1;

/** Hard ceiling. Past sixteen frames the game is unplayable anyway. */
export const MAX_INPUT_DELAY = 16;

/** SNES NTSC, used when the caller does not say what the machine runs at. */
export const DEFAULT_FPS = 60.0988;

/**
 * Late frames per window at which the peer is judged to be in trouble.
 *
 * Zero is the healthy figure, including for the follower: measured against a
 * deliberately generous split, the follower lost no frames at all while its
 * stalled-tick count ran into the thousands. A tight split cost 250 late frames
 * in twenty seconds, which is about 27 per window - so this sits well clear of
 * both.
 */
const STRAIN_AT = 6;

/** Sliding window, in seconds, over which strained seconds are counted. */
const STRAIN_WINDOW_SECONDS = 30;

/**
 * Strained seconds inside that window before a peer adds a frame.
 *
 * Counted in seconds rather than in packets, which is what an earlier version
 * did and got wrong. Packets arrive fifty times a second, so a single
 * three-second burst supplied more than a hundred consecutive hungry ones and
 * tripped the loop by itself - and the frame it cost was permanent. Measured on
 * a real link, strain sat at zero for 96% of a session and spiked on two to four
 * isolated seconds: exactly the shape that must *not* buy a frame.
 *
 * A third of the window is the bar. One burst marks about five seconds, because
 * strain is itself a 128-frame sliding window whose tail outlasts the burst; two
 * bursts in the same half-minute clear ten and earn the frame.
 */
export const DEFAULT_HUNGER_SECONDS = 10;

/** Round-trip samples the host collects before sizing the input delay. */
export const SIZING_SAMPLES = 5;
/** Gap between the pings of the sizing burst, in ms. */
export const SIZING_PING_GAP_MS = 60;
/** How long the host waits for the burst before sizing on what it has. */
export const SIZING_BUDGET_MS = 700;

/**
 * Frames of input delay for a set of round-trip samples.
 *
 * The question is "how long does a pad packet realistically take to arrive",
 * not "what was the average round trip". So the estimate works from the fastest
 * sample plus the spread around it - the pessimistic trip - and adds one frame
 * of slack. The old formula used a single sample and a flat two-frame margin,
 * which overpaid on a clean link and underpaid on a jittery one.
 *
 * The single worst sample is discarded before the spread is measured. A
 * session's first round trip carries the socket, the TLS session and the
 * relay's route cache all waking up; it reads far above the link and never
 * repeats. Two slow samples, though, are a slow link, and those still count.
 */
export function suggestInputDelay(samples: number[] | number, fps = DEFAULT_FPS): number {
	const all = typeof samples === 'number' ? [samples] : samples;
	if (all.length === 0) return MIN_INPUT_DELAY;
	const sorted = [...all].sort((a, b) => a - b);
	const considered = sorted.length >= 3 ? sorted.slice(0, -1) : sorted;
	const best = considered[0];
	const spread = considered[considered.length - 1] - best;
	const frameMs = 1000 / fps;
	/*
	 * Two frames of margin at minimum, and the measured spread on top when it
	 * asks for more.
	 *
	 * The spread was tried as a replacement for the flat two frames and that was
	 * wrong in production: it is measured over a 300ms burst during the
	 * handshake, and it cannot see how the relay actually delivers under play.
	 * A real session sized this way held 0 to 2 frames of the peer's pads and
	 * stalled twenty-four times a second - the same "50fps, stalling on almost
	 * every frame" the flat margin had been introduced to cure. Pads do not
	 * arrive one per frame down a TCP relay; they arrive in clumps, and the
	 * margin is the buffer that absorbs a clump.
	 */
	const margin = Math.max(2, Math.ceil(spread / 2 / frameMs));
	const needed = Math.ceil(best / 2 / frameMs) + margin;
	return Math.max(MIN_INPUT_DELAY, Math.min(MAX_INPUT_DELAY, needed));
}

/** A frame to add or give back, with the wording the session reports. */
export type DelayVerdict = { delta: -1 | 1; reason: string } | null;

export class DelayController {
	private fps: number;
	private hungerSeconds: number;
	private _automatic: boolean;

	private strainedRing = new Uint8Array(STRAIN_WINDOW_SECONDS);
	private strainedAt = -1;
	private strainedSecond = 0;
	private strainedCount = 0;
	private observedSeconds = 0;

	private _sizingSamples: number[] = [];
	private _sizingPings = 0;

	constructor(opts: { fps: number; hungerSeconds: number; automatic: boolean }) {
		this.fps = opts.fps;
		this.hungerSeconds = opts.hungerSeconds;
		this._automatic = opts.automatic;
	}

	get automatic(): boolean {
		return this._automatic;
	}

	/** An escape hatch that moves by itself is not one. */
	pin(): void {
		this._automatic = false;
	}

	/**
	 * Hands the delay back to the loop from wherever it currently sits.
	 *
	 * Does not re-run the handshake sizing: that measurement is long gone, and
	 * it under-reads this relay anyway. The evidence starts fresh, so what the
	 * link did while nobody was acting on it does not spend a frame the instant
	 * control returns.
	 */
	resumeAutomatic(): void {
		if (this._automatic) return;
		this._automatic = true;
		this.resetWindow();
	}

	resetWindow(): void {
		this.strainedRing.fill(0);
		this.strainedCount = 0;
		this.observedSeconds = 0;
	}

	/**
	 * Adds a frame when the peer says it is losing frames, gives one back when
	 * the link has been quiet for a whole window.
	 *
	 * The asymmetry is the whole of the hysteresis - thirty clean seconds to
	 * give a frame back against ten strained ones to take it - so the loop is
	 * quick to protect the other player and slow to reclaim latency for this
	 * one. A link sitting exactly on a frame boundary will cycle between two
	 * values on a timescale of tens of seconds; that is tolerable precisely
	 * because it means the delay is already within one frame of right.
	 *
	 * Coming down at all is safe only because there is a signal worth trusting.
	 * Two earlier attempts lowered on `stalls` and on buffer depth, and both
	 * read the follower's ordinary position as distress. "No strained second in
	 * thirty" says something real: not one frame arrived late in the whole
	 * window. A third attempt refused to descend below any value that had ever
	 * strained, which sounds prudent and instead froze the delay at its
	 * high-water mark for the rest of the session.
	 *
	 * Raising is what the side that needs it cannot do: what keeps a peer's
	 * frames on time is *our* delay arriving early enough. So it reports, and
	 * we act.
	 */
	observePeerStrain(strain: number, current: number, nowMs: number): DelayVerdict {
		if (!this._automatic || this.hungerSeconds <= 0) return null;

		const second = Math.floor(nowMs / 1000);
		if (this.strainedAt < 0) {
			this.strainedAt = 0;
			this.strainedSecond = second;
		} else if (second > this.strainedSecond) {
			const elapsed = second - this.strainedSecond;
			this.observedSeconds = Math.min(STRAIN_WINDOW_SECONDS, this.observedSeconds + elapsed);
			if (elapsed >= STRAIN_WINDOW_SECONDS) {
				// A gap longer than the window means nothing inside it is still
				// relevant. Clearing beats walking the ring, and beats replaying a
				// stall or a backgrounded tab as thirty strained seconds.
				this.strainedRing.fill(0);
				this.strainedCount = 0;
				this.strainedAt = 0;
			} else {
				for (let i = 0; i < elapsed; i++) {
					this.strainedAt = (this.strainedAt + 1) % STRAIN_WINDOW_SECONDS;
					this.strainedCount -= this.strainedRing[this.strainedAt];
					this.strainedRing[this.strainedAt] = 0;
				}
			}
			this.strainedSecond = second;
		}

		// One strained second, no matter how many packets inside it said so.
		if (strain >= STRAIN_AT && this.strainedRing[this.strainedAt] === 0) {
			this.strainedRing[this.strainedAt] = 1;
			this.strainedCount++;
		}

		if (this.strainedCount >= this.hungerSeconds) {
			if (current >= MAX_INPUT_DELAY) return null;
			/*
			 * Start the window over rather than demanding twice the evidence next
			 * time. The frame either helped, in which case strain falls and this
			 * will not qualify again, or the link is genuinely worse than one frame
			 * can cover, in which case it will - and should.
			 */
			this.resetWindow();
			return { delta: 1, reason: 'to keep the other player smooth' };
		}

		if (
			this.observedSeconds >= STRAIN_WINDOW_SECONDS &&
			this.strainedCount === 0 &&
			current - 1 >= MIN_AUTO_DELAY
		) {
			this.resetWindow();
			return { delta: -1, reason: 'the link has been quiet' };
		}

		return null;
	}

	noteSizingPing(): void {
		this._sizingPings++;
	}
	addSizingSample(rtt: number): void {
		this._sizingSamples.push(rtt);
	}
	get sizingPings(): number {
		return this._sizingPings;
	}
	get sizingSamples(): readonly number[] {
		return this._sizingSamples;
	}

	/**
	 * Whether the host has enough of the burst to ship the initial state.
	 *
	 * A session that never starts is worse than one sized on the default, so a
	 * quiet link gives up waiting rather than blocking the handshake.
	 */
	sizingVerdict(startedAt: number, nowMs: number): 'wait' | 'ship' {
		const elapsed = nowMs - startedAt;
		if (this._sizingSamples.length >= SIZING_SAMPLES) return 'ship';
		if (this._sizingSamples.length > 0 && elapsed > SIZING_BUDGET_MS) return 'ship';
		if (elapsed > 1000) return 'ship';
		return 'wait';
	}

	/** The delay the burst asks for, or null if it should not override. */
	sizedDelay(): number | null {
		if (!this._automatic || this._sizingSamples.length === 0) return null;
		return suggestInputDelay(this._sizingSamples, this.fps);
	}
}
```

- [ ] **Step 4 : Lancer pour vérifier le passage**

Run: `node --import tsx --test core/test/delay-control.test.ts`
Expected: PASS, onze tests.

- [ ] **Step 5 : Câbler dans `session.ts`**

- Supprimer de `session.ts` les constantes déplacées et `suggestInputDelay`, et **ré-exporter** pour ne pas casser `core/test/netcode.test.ts` ni `znet/index.ts` :
  ```ts
  export { suggestInputDelay } from './delay-control.js';
  ```
- Remplacer `autoInputDelay`, `strainedRing`, `strainedAt`, `strainedSecond`, `strainedCount`, `observedSeconds`, `sizingSince`, `sizingSamples`, `sizingPings` par `private delayControl: DelayController;`, construit après `this.opts` :
  ```ts
  this.delayControl = new DelayController({
  	fps: this.opts.fps,
  	hungerSeconds: this.opts.hungerSeconds,
  	automatic: !options.inputDelay
  });
  ```
  `sizingSince` reste dans la session : c'est un horodatage de son propre déroulé de handshake, pas de la politique.
- `notePeerStrain` devient :
  ```ts
  private notePeerStrain(strain: number): void {
  	// Recorded before the gates below, so the diagnostics show what the peer
  	// reported even when this side is pinned and will not act on it.
  	this.metrics.notePeerStrain(strain);
  	if (this._state !== 'running') return;
  	const verdict = this.delayControl.observePeerStrain(strain, this.opts.inputDelay, this.now());
  	if (!verdict) return;
  	this.setDelay(this.opts.inputDelay + verdict.delta);
  	this.onEvent({
  		type: 'state',
  		message: verdict.delta > 0
  			? `input delay up to ${this.opts.inputDelay} frames ${verdict.reason}`
  			: `input delay down to ${this.opts.inputDelay} frames, ${verdict.reason}`
  	});
  }
  ```
  Comparer le texte produit avec les messages d'origine (lignes 1058 et 1099) : les tests `netcode.test.ts` qui lisent les événements doivent continuer de matcher.
- `setInputDelay` : `this.delayControl.pin()` à la place de `this.autoInputDelay = false`.
- `resumeAutomaticDelay` : le corps entier devient `this.delayControl.resumeAutomatic();`.
- Dans `pump`, la rafale : `this.delayControl.sizingPings < SIZING_SAMPLES` puis `this.delayControl.noteSizingPing()`. La condition d'expédition devient `this.delayControl.sizingVerdict(this.sizingSince, now) === 'ship'`, et le dimensionnement :
  ```ts
  const sized = this.delayControl.sizedDelay();
  if (sized !== null && sized !== this.opts.inputDelay) {
  	const best = Math.round(Math.min(...this.delayControl.sizingSamples));
  	this.onEvent({
  		type: 'state',
  		message: `input delay ${sized} frames from ${this.delayControl.sizingSamples.length} samples, best ${best}ms`
  	});
  }
  if (sized !== null) this.setDelay(sized);
  ```
- Là où un pong alimentait `sizingSamples`, appeler `this.delayControl.addSizingSample(rtt)`.
- `resetStrainWindow()` devient `this.delayControl.resetWindow()`.

- [ ] **Step 6 : Vérifier**

Run: `npm run test:netplay && npm run test:core`

Expected: tout vert. Les tests décisifs, à lire nommément dans la sortie :
- `one rough patch costs nothing; a link that keeps misbehaving costs a frame`
- `a quiet link is walked down to two frames, but never sized there`
- `a link that recovers gets its frames back`
- `the delay settles on a steady link instead of sawing`
- `handing control back to the loop really hands it back`
- `a pinned delay is never raised behind the player's back`
- `the host sizes the input delay from the link before shipping state`

Un échec sur l'un de ces sept est une erreur d'extraction, jamais un test à ajuster.

- [ ] **Step 7 : Mettre à jour l'en-tête de `session.ts`**

Ajouter au bloc de tête, après la description du modèle, la note qui empêche de rouvrir la question sans raison :

```
 * The engine is split three ways. `pad-timeline.ts` holds what has been
 * sampled and what has arrived; `link-metrics.ts` measures what the link is
 * doing; `delay-control.ts` decides whether the input delay should move. What
 * is left here is the state machine, the transport, and the epoch.
 *
 * The message handlers below are deliberately not extracted. They mutate about
 * fifteen private fields between them, so giving them their own module would
 * mean widening this class's surface to let them in - a shorter file that is
 * harder to reason about.
```

- [ ] **Step 8 : Ajouter la suite à `test:netplay`** et **Commit** (demander l'accord d'abord)

```bash
git add frontend/src/lib/znet/delay-control.ts core/test/delay-control.test.ts \
        frontend/src/lib/znet/session.ts package.json
git commit -m "Sortir la politique de délai de NetplaySession

Le contrôleur décide, la session applique. setDelay reste ici parce qu'il
rebouche le trou que toute montée laisse dans la timeline et réémet la plage,
ce qui demande la timeline et le transport.

L'hystérésis asymétrique - dix secondes tendues pour prendre une frame, trente
propres pour en rendre une - est maintenant testable en onze cas directs. Elle
n'était atteignable qu'en simulant quarante secondes de réseau.

Corrige aussi l'en-tête de notePeerStrain, qui affirmait ne jamais redescendre
alors que le corps le fait depuis l'ajout de la branche de fenêtre propre."
```

---

## Task 8 : Scinder les handlers `lobby:*` du backend

**Files:**
- Create: `backend/src/websocket/invitation-handlers.ts`
- Modify: `backend/src/websocket/room-handlers.ts`, `backend/src/websocket/index.ts`

**Interfaces:**
- Consumes: `joinRoom`, `broadcastRoomUpdate` depuis `room-handlers.js`
- Produces:
  ```ts
  export interface InvitationView { id: string; roomId: string; fromUserId: string;
    fromPseudo: string; fromAvatar?: string; gameTitle?: string; expiresAt: Date; }
  export function pendingInvitationsFor(db: Database, userId: string,
    rooms: Map<string, Room>, now: Date): InvitationView[];
  export function registerInvitationHandlers(socket: Socket, io: Server, user: User,
    rooms: Map<string, Room>, getUserSocket: (id: string) => string | undefined): void;
  ```

- [ ] **Step 1 : Déplacer sans rien changer**

Couper de `room-handlers.ts` vers `invitation-handlers.ts` : `INVITATION_TTL_MS` (41), `InvitationView` (44-53), `toInvitationView` (55-83), `pendingInvitationsFor` (84-112), `findOwnInvitation` (735-755), et les quatre handlers `lobby:invite` (306-400), `lobby:cancel` (401-447), `lobby:accept` (448-535), `lobby:decline` (536-570), enveloppés dans `registerInvitationHandlers`.

Déplacer aussi les imports qui ne servent plus qu'à eux : `createInvitation`, `findInvitationById`, `listPendingInvitationsFor`, `listPendingInvitationsForRoom`, `markInvitation`, `refreshInvitationDeadline`, `Invitation`, `invitationState`, `findFriendshipBetween`. Laisser dans `room-handlers.ts` ceux que les deux utilisent (`deleteInvitationsForRoom` notamment — vérifier).

`joinRoom` doit devenir exporté depuis `room-handlers.ts` pour que `lobby:accept` l'atteigne. La dépendance est à sens unique ; ne pas créer d'import en retour.

- [ ] **Step 2 : Enregistrer dans `index.ts`**

```ts
import { registerInvitationHandlers, pendingInvitationsFor } from './invitation-handlers.js';
```
`pendingInvitationsFor` n'est plus importé de `room-handlers.js`. Ajouter l'appel juste après `registerRoomHandlers` :
```ts
registerInvitationHandlers(socket, io, user, rooms, getUserSocket);
```
**L'ordre compte** : socket.io jette les événements arrivés sans écouteur, et tous les `register*` doivent rester avant le premier `await` de `handleConnection`.

- [ ] **Step 3 : Vérifier**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
cd backend && npx tsc --noEmit && cd ..
npm run test:backend
```
Expected: compilation propre, suites vertes — en particulier `lobby.test.ts` et `lobby-protocol.test.ts`, qui couvrent les quatre événements déplacés.

Vérifier les tailles :
```bash
wc -l backend/src/websocket/room-handlers.ts backend/src/websocket/invitation-handlers.ts
```
Expected: environ 700 et 360.

- [ ] **Step 4 : Commit** (demander l'accord d'abord)

```bash
git add backend/src/websocket/
git commit -m "Séparer les invitations de lobby du cycle de vie des rooms

Un fichier de 1054 lignes portait deux sujets. La dépendance est à sens
unique: les invitations appellent joinRoom et broadcastRoomUpdate, jamais
l'inverse."
```

---

## Task 9 : Découper le point d'entrée backend

**Files:**
- Create: `backend/src/bootstrap/{env-guard,app,jobs,shutdown}.ts`
- Modify: `backend/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  // env-guard.ts
  export function assertUsableEnvironment(isProduction: boolean): void;
  // app.ts
  export function buildApp(redisClient: RedisClientType):
    { app: Express; sessionMiddleware: RequestHandler };
  // jobs.ts
  export async function restoreAndSweep(rooms: Map<string, Room>): Promise<void>;
  export function startBackgroundJobs(rooms: Map<string, Room>): void;
  export async function warmStartupCaches(): Promise<void>;
  // shutdown.ts
  export function installShutdownHandlers(opts: { httpServer: Server;
    redisClient: RedisClientType; rooms: Map<string, Room> }): void;
  ```

- [ ] **Step 1 : Déplacer par blocs, en préservant l'ordre**

Quatre ordonnancements sont porteurs et commentés dans le code actuel. Un déplacement mécanique les perd :

1. `restoreRooms` **doit** être terminé avant `httpServer.listen`, pour que le premier client qui se reconnecte trouve sa room au lieu de courir contre la restauration.
2. Les trois `io.engine.use(...)` gardent leur ordre et viennent après la construction du middleware de session.
3. `app.use(errorHandler)` reste après toutes les routes.
4. Le balayage des rooms abandonnées tourne une fois à la restauration, avant d'armer la minuterie horaire.

`requirePseudo` reste appliqué dans `buildApp` au montage des routeurs, groupé sur un écran, avec son commentaire : c'est ce qui force une décision explicite à chaque routeur ajouté.

- [ ] **Step 2 : Réécrire `index.ts` en racine de composition**

```ts
import 'dotenv/config';
import { createServer } from 'http';
import { Server } from 'socket.io';
import passport from 'passport';

import { assertUsableEnvironment } from './bootstrap/env-guard.js';
import { buildApp } from './bootstrap/app.js';
import { restoreAndSweep, startBackgroundJobs, warmStartupCaches } from './bootstrap/jobs.js';
import { installShutdownHandlers } from './bootstrap/shutdown.js';
import { connectRedis } from './db/redis.js';
import { initializeWebSocket, getRooms } from './websocket/index.js';
import { logger } from './utils/logger.js';

const isProduction = process.env.NODE_ENV === 'production';
assertUsableEnvironment(isProduction);

/*
 * Last-resort safety nets. Route and socket handlers are wrapped so their
 * rejections are handled locally; these only catch what slipped through, and
 * exist so an isolated failure is logged instead of killing the server.
 */
process.on('unhandledRejection', (reason) => {
	logger.error({ err: reason }, 'Unhandled promise rejection (server kept alive)');
});
process.on('uncaughtException', (err) => {
	// State is unknown after an uncaught throw, so exit and let the restart
	// policy take over rather than serving from a corrupted process.
	logger.fatal({ err }, 'Uncaught exception, shutting down');
	process.exit(1);
});

initializeAuth();
const redisClient = await connectRedis();
const { app, sessionMiddleware } = buildApp(redisClient);

const httpServer = createServer(app);
const io = new Server(httpServer, {
	cors: { origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true },
	maxHttpBufferSize: 1e8,
	perMessageDeflate: false,
	httpCompression: false
});

io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());
initializeWebSocket(io);

const rooms = getRooms();

// Before the port opens, so the first client to reconnect finds its room
// already there rather than racing the restore.
await restoreAndSweep(rooms);
startBackgroundJobs(rooms);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
	logger.info(`🚀 Server running on http://localhost:${PORT}`);
	await warmStartupCaches();
});

installShutdownHandlers({ httpServer, redisClient, rooms });
```

Reprendre dans les modules les options exactes de `helmet`, `compression` et `cors`, et les commentaires qui les justifient (`maxHttpBufferSize: 1e8` pour les grandes frames, `perMessageDeflate: false` pour la latence).

- [ ] **Step 3 : Vérifier**

Run:
```bash
cd backend && npx tsc --noEmit && cd ..
npm run test:backend
docker-compose up --build -d && sleep 20 && docker-compose logs backend | tail -30
```
Expected: compilation propre, suites vertes, et dans les logs `Server running`, la restauration des rooms **avant** l'ouverture du port. Puis `docker-compose down`.

Le démarrage conteneurisé est le seul contrôle qui exerce l'ordre d'amorçage : les tests ne l'atteignent pas.

- [ ] **Step 4 : Commit** (demander l'accord d'abord)

```bash
git add backend/src/bootstrap/ backend/src/index.ts
git commit -m "Faire du point d'entrée backend une racine de composition

353 lignes qui mêlaient validation des secrets, câblage Express, tâches de
fond et arrêt gracieux, vers environ 50.

Quatre ordonnancements sont porteurs et sont conservés explicitement, dont
celui qui compte le plus: restoreRooms avant listen, faute de quoi le premier
client à se reconnecter court contre la restauration de sa propre room."
```

---

## Task 10 : Extraire `sram.ts` et `input-sources.ts`

Les deux plus petits modules du chantier 3, faits ensemble : ils n'ont aucune interaction réactive et servent d'échauffement avant `renderer-surface`.

**Files:**
- Create: `frontend/src/lib/rooms/sram.ts`, `frontend/src/lib/rooms/input-sources.ts`
- Modify: `frontend/src/lib/components/{LockstepRoom,SoloRoom}.svelte`

**Interfaces:**
- Consumes: `toBase64`, `fromBase64` (tâche 3) ; `loadAssignments`, `connectedPads`, `resolveSources` depuis `$lib/znet`
- Produces:
  ```ts
  // sram.ts
  export interface SramCore { sram(): Uint8Array; loadSram(bytes: Uint8Array): void; }
  export function encodeSram(core: SramCore): string | null;
  export function decodeSram(base64: string): Uint8Array;
  // input-sources.ts
  export interface SourceTarget { setSources(source: unknown): void; }
  export function applyInputSources(
    storage: Storage,
    collectors: (SourceTarget | null)[]
  ): { assignments: Assignments; padCount: number };
  ```

- [ ] **Step 1 : Écrire `sram.ts`**

```ts
/**
 * Reading the battery save out of a machine and putting one back.
 *
 * Three components did this, with three different encodings, one of which
 * built an 800KB string a character at a time. The encoding itself lives in
 * `saves/base64.ts`; this is the part that knows a core has an empty SRAM when
 * the cartridge has no battery.
 */
import { toBase64, fromBase64 } from '$lib/saves/base64';

export interface SramCore {
	sram(): Uint8Array;
	loadSram(bytes: Uint8Array): void;
}

/** The machine's battery save, or null when the cartridge has none. */
export function encodeSram(core: SramCore): string | null {
	const sram = core.sram();
	if (sram.length === 0) return null;
	return toBase64(sram);
}

export function decodeSram(base64: string): Uint8Array {
	return fromBase64(base64);
}
```

- [ ] **Step 2 : Écrire `input-sources.ts`**

`applySources` diffère entre les deux composants uniquement par le nombre de collecteurs. Le tableau règle ça sans fourche.

```ts
/**
 * Points each player's collector at whatever device is currently assigned.
 *
 * Called on every gamepad connect and disconnect, and once when the pause menu
 * closes: `ControlsSettings` writes a device assignment straight to storage
 * without dispatching anything, so this is the one place a device reassigned
 * while paused reaches the running collectors.
 *
 * Returns the pad count rather than deciding about the touch pad. Whether a
 * drawn pad is wanted is the component's call, and the two rooms answer it
 * differently.
 */
import { connectedPads, loadAssignments, resolveSources, type Assignments } from '$lib/znet';

export interface SourceTarget {
	setSources(source: unknown): void;
}

export function applyInputSources(
	storage: Storage,
	collectors: (SourceTarget | null)[]
): { assignments: Assignments; padCount: number } {
	const assignments = loadAssignments(storage);
	const pads = connectedPads();
	const sources = resolveSources(assignments, pads);
	const perPlayer = [sources.p1, sources.p2];
	collectors.forEach((collector, i) => collector?.setSources(perPlayer[i]));
	return { assignments, padCount: pads.length };
}
```

Vérifier le type réel renvoyé par `resolveSources` dans `frontend/src/lib/znet/devices.ts` et remplacer `unknown` par ce type exact. Ne pas laisser `unknown` dans le code livré.

- [ ] **Step 3 : Câbler les deux composants**

Dans `LockstepRoom.svelte`, `applySources` devient :
```ts
function applySources(): void {
	const applied = applyInputSources(localStorage, [collector]);
	assignments = applied.assignments;
	// Plugging a controller into a tablet takes the drawn one away, and
	// unplugging it brings it back: this runs on both gamepad events.
	showTouchPad = touchPadWanted(applied.padCount);
}
```
Dans `SoloRoom.svelte`, identique avec `[collector1, collector2]`.

`assignments` et `showTouchPad` restent des `let` du composant, assignés ici. **Ne pas** les déplacer dans le module : ce sont exactement les variables réactives que le template lit par leur nom.

`persistSram` dans les deux composants devient :
```ts
function persistSram(): void {
	if (!core || !$socket) return;
	const sramData = encodeSram(core);
	if (!sramData) return;
	$socket.emit('game:saveSram', { roomId, sramData });
}
```
en conservant les gardes propres à chacun — `!isHost` pour Lockstep, `!sramLoaded` pour Solo.

- [ ] **Step 4 : Vérifier, y compris le gel réactif**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node scripts/svelte-frozen-props.mjs $(find frontend/src -name '*.svelte' | sort)
npm run test:ui && npm run test:core
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -5
```
Expected: **exactement les six sites de la référence de la tâche 1**, aucun nouveau. Suites vertes.

- [ ] **Step 5 : Commit** (demander l'accord d'abord)

```bash
git add frontend/src/lib/rooms/sram.ts frontend/src/lib/rooms/input-sources.ts \
        frontend/src/lib/components/LockstepRoom.svelte frontend/src/lib/components/SoloRoom.svelte
git commit -m "Partager le SRAM et l'affectation des périphériques entre Solo et Lockstep"
```

---

## Task 11 : Extraire `renderer-surface.ts`

Le bloc le plus dupliqué, et celui où le piège Svelte 4 est réel.

**Files:**
- Create: `frontend/src/lib/rooms/renderer-surface.ts`
- Modify: `frontend/src/lib/components/{LockstepRoom,SoloRoom}.svelte`

**Interfaces:**
- Consumes: `CanvasRenderer`, `WebglRenderer`, `loadShaderPreset`, `DisplayOptions`, `Renderer` depuis `$lib/znet`
- Produces:
  ```ts
  export interface SurfaceState { renderer: Renderer; usingGl: boolean; shader: string; notice: string | null; }
  export function createRendererSurface(opts: {
    canvas2d: HTMLCanvasElement;
    canvasGl: HTMLCanvasElement;
    onChange: (state: SurfaceState) => void;
  }): {
    useCanvas(display: DisplayOptions): void;
    apply(shaderId: string, display: DisplayOptions): Promise<void>;
    checkHealth(display: DisplayOptions): void;
    dispose(): void;
  };
  ```

- [ ] **Step 1 : Comprendre pourquoi l'interface a cette forme**

`usingGl` et `renderer` sont lus comme **identifiants nus** par des statements réactifs des deux composants :

```svelte
$: activeCanvas = usingGl ? canvasGl : canvas2d;
$: if (renderer && display) renderer.setOptions(display);
```

Si ces deux valeurs déménagent dans un objet, `$: activeCanvas = surface.usingGl ? …` dépend de `surface`, qui n'est affecté qu'une fois : le statement ne se réévalue plus jamais et le canvas affiché se fige sur celui du premier rendu.

C'est pourquoi le module **ne détient aucun état réactif**. Il gère le cycle de vie impératif et rapporte par `onChange` ; le composant garde `let renderer`, `let usingGl`, `let display`, `let shaderNotice` comme variables ordinaires que Svelte voit assigner.

- [ ] **Step 2 : Écrire le module**

Les corps viennent de `SoloRoom.svelte:184-272` et `LockstepRoom.svelte:227-324`, qui ne diffèrent que par leurs commentaires. Garder la version la plus informative de chaque commentaire.

```ts
/**
 * The 2D-or-WebGL picture, and the shader swaps between them.
 *
 * Identical in SoloRoom and LockstepRoom down to the control flow; only the
 * comments differed. Extracted so a shader bug is fixed once.
 *
 * Holds no reactive state on purpose. Svelte 4 derives a reactive statement's
 * dependencies from the identifiers written in it, and both rooms read
 * `renderer` and `usingGl` by name from a `$:`. Moving them into this object
 * would freeze those statements at their first value, with no error and no
 * warning. So the caller keeps them as plain `let` bindings and this reports
 * changes through `onChange`.
 */
import {
	CanvasRenderer,
	WebglRenderer,
	loadShaderPreset,
	type DisplayOptions,
	type Renderer
} from '$lib/znet';

export interface SurfaceState {
	renderer: Renderer;
	usingGl: boolean;
	/** Empty when the picture is 2D, whatever the caller asked for. */
	shader: string;
	notice: string | null;
}

export function createRendererSurface(opts: {
	canvas2d: HTMLCanvasElement;
	canvasGl: HTMLCanvasElement;
	onChange: (state: SurfaceState) => void;
}) {
	let renderer: Renderer | null = null;
	/** Guards against overlapping swaps when the player clicks quickly. */
	let swapToken = 0;

	/** Drops back to the 2D renderer on its own canvas. Always succeeds. */
	function useCanvas(display: DisplayOptions, notice: string | null = null): void {
		renderer?.dispose();
		/*
		 * The button reads display.shader and nothing else, so leaving it set
		 * would keep advertising a shader that is not running. The stored
		 * preference is deliberately left alone: it is the player's choice, and
		 * it should be retried on the next load rather than silently forgotten.
		 */
		const next = { ...display, shader: '' };
		renderer = new CanvasRenderer(opts.canvas2d);
		renderer.setOptions(next);
		opts.onChange({ renderer, usingGl: false, shader: '', notice });
	}

	/**
	 * Switches the picture to `shaderId`, or keeps 2D and says why.
	 *
	 * Every failure lands in the same place: a working 2D renderer plus a
	 * notice. The player is never left looking at a black canvas wondering
	 * whether the game crashed - which is exactly what xbrz-freescale used to do
	 * before it was removed from the shader list.
	 */
	async function apply(shaderId: string, display: DisplayOptions): Promise<void> {
		const token = ++swapToken;

		if (!shaderId) {
			useCanvas(display);
			return;
		}

		const loaded = await loadShaderPreset(shaderId);
		// The player may have picked something else while this was fetching.
		if (token !== swapToken) return;

		if (!loaded.ok) {
			useCanvas(display, loaded.message);
			return;
		}

		/*
		 * If WebglRenderer.create fails below, useCanvas() disposes this same
		 * (already-disposed) renderer again. That is safe: dispose() on both
		 * renderer types guards every deletion and nulls what it deletes, so
		 * nothing gets double-freed.
		 */
		renderer?.dispose();

		const webgl = WebglRenderer.create(opts.canvasGl, loaded.preset);
		if (!webgl) {
			useCanvas(display, `${shaderId} could not start; showing the plain picture.`);
			return;
		}

		renderer = webgl;
		renderer.setOptions(display);
		opts.onChange({ renderer, usingGl: true, shader: shaderId, notice: null });
	}

	/** Falls back to 2D if the GL context died mid-game. */
	function checkHealth(display: DisplayOptions): void {
		if (!renderer || !(renderer instanceof WebglRenderer)) return;
		if (renderer.healthy) return;
		useCanvas(display, 'The shader stopped; showing the plain picture.');
	}

	function dispose(): void {
		swapToken++;
		renderer?.dispose();
		renderer = null;
	}

	return { useCanvas, apply, checkHealth, dispose };
}
```

Relire les deux originaux avant d'écrire : reprendre les textes de notice **mot pour mot** (les tests d'interface et les traductions peuvent en dépendre) et vérifier la vraie API de `WebglRenderer` (nom du contrôle de santé, forme de `loadShaderPreset().ok/message/preset`) dans `frontend/src/lib/znet/{webgl-renderer,shader-source}.ts`. Ne pas inventer de membre.

- [ ] **Step 3 : Câbler les deux composants**

Dans chacun, remplacer les quatre fonctions par :

```ts
let surface: ReturnType<typeof createRendererSurface> | null = null;

function onSurfaceChange(state: SurfaceState): void {
	renderer = state.renderer;
	usingGl = state.usingGl;
	display = { ...display, shader: state.shader };
	shaderNotice = state.notice;
}

function useCanvasRenderer(): void {
	surface?.useCanvas(display);
}

async function applyShader(shaderId: string): Promise<void> {
	await surface?.apply(shaderId, display);
}

async function onDisplayChange(next: DisplayOptions): Promise<void> {
	const shaderChanged = next.shader !== display.shader;
	display = next;
	if (!shaderChanged) return;
	// Remembered the same way the profile page remembers it.
	writeShaderPreference(localStorage, next.shader);
	await applyShader(next.shader);
}

function checkRendererHealth(): void {
	surface?.checkHealth(display);
}
```

`surface` est créé dans `boot()`, là où les canvas existent : `surface = createRendererSurface({ canvas2d, canvasGl, onChange: onSurfaceChange });`. Détruit dans `teardown()` par `surface?.dispose()`.

Les quatre `let` — `renderer`, `usingGl`, `display`, `shaderNotice` — **restent dans le composant** et ne bougent pas.

`SoloRoom` conserve sa particularité au statement réactif (dessiner une frame quand le menu pause est ouvert, parce que rien d'autre ne viendra montrer le changement) :
```svelte
$: if (renderer && display) {
	renderer.setOptions(display);
	if (showPauseMenu && core) renderer.draw(core);
}
```

- [ ] **Step 4 : Vérifier**

Run:
```bash
node scripts/svelte-frozen-props.mjs $(find frontend/src -name '*.svelte' | sort)
npm run test:ui && npm run test:core
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -5
```
Expected: six sites, les mêmes qu'à la tâche 1. Suites vertes.

- [ ] **Step 5 : Vérifier dans l'application, pas seulement en test**

Aucun test ne rend réellement un shader. Lancer la pile, ouvrir une room solo, ouvrir le menu pause, changer de shader dans les deux sens, puis changer le ratio d'aspect. Le rendu doit suivre à chaque fois.

Run: `npm run dev` puis ouvrir `http://localhost:5173`.
Expected: le shader s'applique et se retire ; le ratio change à l'écran, pas seulement dans le libellé du menu — c'est précisément la classe de défaut sur laquelle cette branche a déjà été prise deux fois.

- [ ] **Step 6 : Commit** (demander l'accord d'abord)

```bash
git add frontend/src/lib/rooms/renderer-surface.ts \
        frontend/src/lib/components/LockstepRoom.svelte frontend/src/lib/components/SoloRoom.svelte
git commit -m "Partager la surface de rendu entre Solo et Lockstep

Le bloc renderer et shader était identique dans les deux composants au
commentaire près. Un défaut de shader se corrigeait deux fois.

Le module ne détient aucun état réactif: les deux rooms lisent renderer et
usingGl par leur nom depuis un \$:, et les déplacer dans un objet aurait figé
ces statements sur leur première valeur, sans erreur ni avertissement."
```

---

## Task 12 : Extraire `fullscreen.ts` et `chrome-autohide.ts`

**`boot.ts` est retiré du périmètre.** Le spec le listait ; l'examen du code le contredit, et c'est le plan qui a raison ici.

La partie réellement commune aux deux `obtainRom` (`SoloRoom:285-294`, `LockstepRoom:1025-1034`) fait dix lignes — une garde sur `gameCrc32`, un appel à `resolveQuietly`, une ligne de log — et `resolveQuietly` **est déjà** le helper partagé que les deux appellent. Après ces dix lignes ils divergent entièrement : le client lockstep demande la ROM à l'hôte avant de demander au joueur, ce que Solo ne peut pas faire.

Quant au reste de `boot()`, il séquence douze variables réactives du composant (`statusText`, `core`, `loadedRom`, `display`, `renderer`, `audio`, `needsAudioGesture`, `assignments`, `showTouchPad`, `collector`, `phase`, `transport`). L'extraire imposerait de passer douze setters, ou de sortir l'état réactif du composant — c'est-à-dire exactement le piège que la contrainte globale interdit. On échangerait 150 lignes séquentielles lisibles contre une soupe de callbacks moins claire que l'original.

À noter dans le message de commit, pour que la question ne soit pas rouverte.

**Files:**
- Create: `frontend/src/lib/rooms/fullscreen.ts`, `frontend/src/lib/rooms/chrome-autohide.ts`
- Modify: `frontend/src/lib/components/{LockstepRoom,SoloRoom}.svelte`

**Interfaces:**
- Produces:
  ```ts
  // fullscreen.ts
  export function createFullscreen(opts: {
    element: () => HTMLElement | undefined;
    onChange: (isFullscreen: boolean, deliberate: boolean) => void;
  }): { toggle(): Promise<void>; restore(): void; attach(): void; detach(): void };
  // chrome-autohide.ts
  export function createChromeAutohide(opts: {
    idleMs: number; onVisibility: (visible: boolean) => void;
  }): { reveal(active: boolean): void; hold(): void; release(): void; stop(): void };
  ```

- [ ] **Step 1 : Comprendre ce qui n'est pas partagé**

Contrairement au bloc renderer, plein écran et pause **ne sont pas identiques**, et la différence est voulue. Elle ne doit pas être absorbée dans une abstraction :

- Solo arrête vraiment son governor en pause. Lockstep ne peut pas : arrêter son horloge cesserait d'émettre les pads et figerait le pair.
- Lockstep distingue une sortie de plein écran volontaire d'un Échap (`deliberateFullscreenChange`), parce qu'Échap veut dire « ouvre le menu » ici et que le keydown ne lui parvient jamais.
- Lockstep seul masque sa barre d'outils après inactivité.

Le module couvre la bascule et la distinction volontaire/Échap. Les **politiques de pause restent dans chaque composant** : ce sont deux décisions différentes, pas une duplication.

- [ ] **Step 2 : Écrire `fullscreen.ts`**

Reprend `toggleFullscreen` et `onFullscreenChange` de `LockstepRoom:500-528`.

```ts
/**
 * Fullscreen, and the difference between leaving it and being thrown out of it.
 *
 * The distinction is the whole reason this is not two lines inline: the only
 * way out of fullscreen the page did not ask for is Escape, and in a room
 * Escape means "open the menu" - but the keydown never arrives, the browser
 * consumes it. So a change that was not deliberate has to be recognisable.
 *
 * `element` is a getter, not a value: the stage does not exist when the
 * component's script runs, and passing the binding directly would capture
 * undefined for the lifetime of the room.
 */
export function createFullscreen(opts: {
	element: () => HTMLElement | undefined;
	onChange: (isFullscreen: boolean, deliberate: boolean) => void;
}) {
	let deliberate = false;

	function onFullscreenChange(): void {
		const wasDeliberate = deliberate;
		deliberate = false;
		opts.onChange(!!document.fullscreenElement, wasDeliberate);
	}

	async function toggle(): Promise<void> {
		deliberate = true;
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await opts.element()?.requestFullscreen();
		} catch (err) {
			deliberate = false;
			throw err;
		}
	}

	/** Goes back to fullscreen after a menu that was opened from it. */
	function restore(): void {
		if (document.fullscreenElement) return;
		deliberate = true;
		void opts.element()?.requestFullscreen().catch(() => {
			deliberate = false;
		});
	}

	function attach(): void {
		document.addEventListener('fullscreenchange', onFullscreenChange);
	}
	function detach(): void {
		document.removeEventListener('fullscreenchange', onFullscreenChange);
	}

	return { toggle, restore, attach, detach };
}
```

`toggle` propage l'erreur au lieu de la journaliser : le logger appartient au composant, et c'est lui qui sait sous quel nom le dire.

- [ ] **Step 3 : Écrire `chrome-autohide.ts`**

Reprend `revealChrome`, `holdChrome`, `releaseChrome` et `chromeTimer` de `LockstepRoom:529-558`.

```ts
/**
 * Shows the in-game toolbar, then hides it again after a while.
 *
 * Sixty lines of timer bookkeeping in a component that had far too much of it.
 * `reveal` takes the fullscreen state as a parameter rather than reading it:
 * out of fullscreen the toolbar sits in normal flow and there is nothing to
 * hide, and passing it in keeps this module free of reactive state.
 */
export function createChromeAutohide(opts: {
	idleMs: number;
	onVisibility: (visible: boolean) => void;
}) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let held = false;

	function clear(): void {
		if (timer) clearTimeout(timer);
		timer = null;
	}

	/** Shows the toolbar and restarts the countdown that hides it again. */
	function reveal(active: boolean): void {
		opts.onVisibility(true);
		clear();
		if (!active || held) return;
		timer = setTimeout(() => {
			timer = null;
			opts.onVisibility(false);
		}, opts.idleMs);
	}

	/** Keeps it up while a menu inside it is open. */
	function hold(): void {
		held = true;
		reveal(true);
	}

	function release(): void {
		held = false;
		reveal(true);
	}

	function stop(): void {
		clear();
		held = false;
	}

	return { reveal, hold, release, stop };
}
```

- [ ] **Step 4 : Câbler dans `LockstepRoom`**

`isFullscreen`, `chromeVisible` et `chromeHeld` restent des `let` du composant, assignés depuis les callbacks — même raison qu'à la tâche 11. `deliberateFullscreenChange` et `chromeTimer` disparaissent, ils sont maintenant internes aux modules.

```ts
const chrome = createChromeAutohide({
	idleMs: CHROME_IDLE_MS,
	onVisibility: (visible) => (chromeVisible = visible)
});

const fullscreen = createFullscreen({
	element: () => stage,
	onChange: (active, deliberate) => {
		isFullscreen = active;
		if (active) {
			chrome.reveal(true);
			return;
		}
		chrome.stop();
		chromeVisible = true;
		// The only way out of fullscreen we did not ask for is Escape, which in
		// this room means "open the menu" - and the keydown never reached us.
		if (!deliberate) openPauseMenu(true);
	}
});

async function toggleFullscreen(): Promise<void> {
	try {
		await fullscreen.toggle();
	} catch (err) {
		logger.error('Could not toggle fullscreen', err);
	}
}

/**
 * Cheap guard on a listener that fires on every mouse move in the page: out of
 * fullscreen the toolbar is in normal flow and there is nothing to show.
 */
function onPointerActivity(): void {
	if (isFullscreen) chrome.reveal(true);
}
```

`fullscreen.attach()` dans `onMount`, `fullscreen.detach()` et `chrome.stop()` dans `teardown()`. Le `restoreFullscreen` de `closePauseMenu` devient `fullscreen.restore()`.

Dans `SoloRoom`, câbler `createFullscreen` avec `element: () => container` et un `onChange` qui n'utilise que le premier argument — Solo n'a pas de barre à masquer et n'ouvre pas son menu sur Échap-hors-plein-écran. Conserver le commentaire qui explique pourquoi le composant restaure le plein écran lui-même plutôt que de passer la prop à `PauseMenu` (celle-ci mettrait `document.documentElement` en plein écran, pas le conteneur de la room).

- [ ] **Step 5 : Vérifier**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node scripts/svelte-frozen-props.mjs $(find frontend/src -name '*.svelte' | sort)
npm run test:ui && npm run test:core
npx playwright test --config e2e/playwright.config.ts e2e/local-roms.spec.ts e2e/resume-from-save.spec.ts
wc -l frontend/src/lib/components/LockstepRoom.svelte frontend/src/lib/components/SoloRoom.svelte
```
Expected: les six sites de la référence, suites vertes, et les deux composants sous 1 000 lignes (cibles : environ 1 000 et 680 — `boot.ts` n'étant plus extrait, les cibles annoncées au spec montent d'une cinquantaine de lignes chacune).

- [ ] **Step 6 : Vérifier le plein écran à la main**

Aucun test ne pilote l'API plein écran ; c'est la seule façon de savoir. Dans une room lockstep : passer en plein écran, bouger la souris (la barre réapparaît puis se masque après le délai), ouvrir un menu dans la barre (elle reste), appuyer sur Échap (le menu pause s'ouvre — c'est la distinction volontaire/Échap), reprendre (le plein écran revient).

- [ ] **Step 7 : Commit** (demander l'accord d'abord)

```bash
git add frontend/src/lib/rooms/fullscreen.ts frontend/src/lib/rooms/chrome-autohide.ts \
        frontend/src/lib/components/LockstepRoom.svelte frontend/src/lib/components/SoloRoom.svelte
git commit -m "Sortir le plein écran et le masquage de barre des composants de room

Le plan prévoyait aussi un boot.ts partagé. Il est abandonné après lecture: la
part réellement commune aux deux obtainRom fait dix lignes, et resolveQuietly
est déjà le helper que les deux appellent. Le reste de boot() séquence douze
variables réactives du composant, et l'extraire demanderait de passer douze
setters ou de sortir l'état réactif - ce qui est précisément le piège Svelte 4
que cette passe surveille."
```

---

## Task 13 : Extraire `room-session.ts` de la page room

**Files:**
- Create: `frontend/src/lib/rooms/room-session.ts`
- Modify: `frontend/src/routes/room/[id]/+page.svelte`

**Interfaces:**
- Produces:
  ```ts
  export interface RoomView { room: Room | null; isCreator: boolean; isHost: boolean;
    isSinglePlayer: boolean; effectiveMode: EmulationMode | undefined; canResume: boolean; }
  export function deriveRoomView(room: Room | null, userId: string | undefined): RoomView;
  export function subscribeToRoom(opts: {
    socket: Socket; roomId: string;
    onRoom: (room: Room) => void;
    onError: (payload: { message?: string; code?: string; roomId?: string }) => void;
    onStarted: () => void;
  }): () => void;
  ```

- [ ] **Step 1 : Sortir les dérivés en fonction pure**

Reprend les lignes 32, 107, 117, 120 et 135-137, **commentaires compris** : ils portent des défauts déjà payés une fois, et un commentaire perdu dans un déplacement est un défaut qui revient.

```ts
/**
 * What the lobby needs to know about a room, derived in one place.
 *
 * A pure function of the room and the viewer, so the page can hold it as a
 * plain reactive value. It is called from a `$:` that names both its inputs -
 * `$: view = deriveRoomView(room, $user?.id)` - because Svelte 4 reads a
 * statement's dependencies from the identifiers written in it, and a call
 * whose arguments hide them would freeze the whole view at mount.
 */
import { onlinePlayers } from '$lib/rooms/online-players';
import { EmulationMode, type Room } from '$lib/types';

export interface RoomView {
	room: Room | null;
	isCreator: boolean;
	isHost: boolean;
	isSinglePlayer: boolean;
	effectiveMode: EmulationMode | undefined;
	canResume: boolean;
}

export function deriveRoomView(room: Room | null, userId: string | undefined): RoomView {
	/*
	 * Online, not member count.
	 *
	 * A partner who closed their tab is still in `room.players`, so counting
	 * members here would put a single player into netplay: two cores exchanging
	 * inputs with nobody on the other end. The invite panel still counts members
	 * - an away member's seat is theirs - which is why these two disagree.
	 */
	const isSinglePlayer = room ? onlinePlayers(room).length <= 1 : true;

	const effectiveMode = isSinglePlayer ? EmulationMode.SINGLE : room?.emulationMode;

	/*
	 * Whether the mode this room would start in can open on a save at all.
	 *
	 * Only `SoloRoom` and `LockstepRoom` listen for `game:loaded`; `P2PRoom`,
	 * which runs the dual and streaming modes, has no savestate path at all - not
	 * from here and not from its own pause menu. So a staged save in those modes
	 * is not a bug to route around, it is a thing that does not exist, and the
	 * lobby says so rather than starting a fresh game without a word.
	 *
	 * Derived from the effective mode, which collapses to SINGLE while the partner
	 * is away. That makes the notice come and go with the partner, which is
	 * exactly right: with one player it is `SoloRoom` that runs, and it resumes.
	 */
	const canResume =
		effectiveMode === EmulationMode.SINGLE || effectiveMode === EmulationMode.LOCKSTEP;

	return {
		room,
		isCreator: room?.createdBy === userId,
		isHost: room?.hostId === userId,
		isSinglePlayer,
		effectiveMode,
		canResume
	};
}
```

Dans la page :
```svelte
$: view = deriveRoomView(room, $user?.id);
```
puis lire `view.isCreator`, `view.canResume`, etc. **Ne pas** écrire `$: isCreator = deriveRoomView(room, $user?.id).isCreator` en six exemplaires : un seul appel, une seule valeur.

`activeEmulationMode` **ne bouge pas**. C'est un `let` délibérément gelé à `game:started`, avec un commentaire de dix-huit lignes expliquant que le dériver du compte de joueurs vivant détruisait l'émulateur en cours de partie. Le transformer en dérivé rejouerait ce défaut.

- [ ] **Step 2 : Sortir l'abonnement socket**

```ts
/**
 * Wires a page to a room's socket events, and hands back the way to unwire it.
 *
 * The listeners are registered together and removed together: a listener left
 * behind after a navigation fires against a dead component, and the symptom
 * only shows up after several room changes, which is what made it hard to find
 * the first time.
 */
export function subscribeToRoom(opts: {
	socket: Socket;
	roomId: string;
	onRoom: (room: Room) => void;
	onError: (payload: { message?: string; code?: string; roomId?: string }) => void;
	onStarted: () => void;
}): () => void {
	const { socket } = opts;
	socket.on('room:updated', opts.onRoom);
	socket.on('error', opts.onError);
	socket.on('game:started', opts.onStarted);
	return () => {
		socket.off('room:updated', opts.onRoom);
		socket.off('error', opts.onError);
		socket.off('game:started', opts.onStarted);
	};
}
```

**Avant d'écrire ce corps, relire `onMount` (566-640) et `onDestroy` (641-672) et reproduire la liste exacte des événements.** Celle ci-dessus est le squelette, pas l'inventaire : la page en écoute davantage, et tout événement écouté au montage doit être retiré ici. Vérifier après coup que `onDestroy` ne retire plus rien à la main :

```bash
grep -n "socket?.off\|\$socket?.off" "frontend/src/routes/room/[id]/+page.svelte"
```
Expected: aucune sortie — tout passe par la fonction de désabonnement.

- [ ] **Step 3 : Vérifier**

Run:
```bash
node scripts/svelte-frozen-props.mjs $(find frontend/src -name '*.svelte' | sort)
npm run test:ui && npm run test:core
npx playwright test --config e2e/playwright.config.ts e2e/room-authz.spec.ts e2e/resilience.spec.ts
```
Expected: six sites, tout vert.

- [ ] **Step 4 : Vérifier la reprise à deux joueurs**

Le scénario que les tests ne couvrent pas complètement. Deux onglets, une room lockstep, démarrer, sauvegarder, quitter, reprendre depuis la sauvegarde. Puis recharger l'un des deux onglets en cours de partie : le joueur doit retrouver la partie.

- [ ] **Step 5 : Commit** (demander l'accord d'abord)

---

## Task 14 : Archiver les instantanés de documentation

**Files:**
- Create: `docs/history/README.md`
- Move: treize fichiers

- [ ] **Step 1 : Déplacer**

```bash
mkdir -p docs/history
git mv LATENCY_FIX_SUMMARY.md LATENCY_OPTIMIZATION.md CHANGELOG_DUAL_MODE.md \
       TEST_DUAL_MODE.md ROLLBACK_NETCODE_PLAN.md DOCKER_COMPOSE_UPDATE.md docs/history/
git mv docs/DUAL_EMULATION_MODE_PLAN.md docs/DUAL_EMULATION_MODE.md \
       docs/DUAL_MODE_QUICK_START.md docs/DUAL_MODE_SUMMARY.md \
       docs/DUAL_MODE_IMPLEMENTATION_PROGRESS.md docs/DEPLOYMENT_SUMMARY.md \
       docs/COMMIT_MESSAGE.md docs/history/
```

Ne **pas** déplacer `docs/QUICKSTART.md`, `docs/GOOGLE_OAUTH_SETUP.md`, `docs/GITHUB_ACTIONS.md`, `docs/ROM_SYNC_FEATURE.md`, `docs/SPEED_CONTROLS.md`, `docs/P2P_ARCHITECTURE.md` : ce sont des documents de référence sur des sujets toujours en place. Le critère est la nature du document, pas sa date.

- [ ] **Step 2 : Écrire l'index**

`docs/history/README.md` :
```markdown
# Instantanés

Des comptes rendus de travaux terminés, conservés pour le raisonnement qu'ils
contiennent : les mesures, les impasses, et pourquoi telle option a été écartée.

**Ils décrivent un état passé au présent.** Ce ne sont pas des descriptions du
produit actuel. Pour cela, voir `ARCHITECTURE.md` à la racine, et
`LOCKSTEP_NETPLAY.md` pour le netcode.
```

- [ ] **Step 3 : Corriger les liens cassés**

```bash
grep -rn "LATENCY_FIX_SUMMARY\|LATENCY_OPTIMIZATION\|CHANGELOG_DUAL_MODE\|TEST_DUAL_MODE\|ROLLBACK_NETCODE_PLAN\|DOCKER_COMPOSE_UPDATE\|DUAL_EMULATION_MODE\|DUAL_MODE_\|DEPLOYMENT_SUMMARY" \
  --include='*.md' . | grep -v '^./docs/history/'
```
Expected: aucune sortie après correction des liens trouvés (README.md notamment).

- [ ] **Step 4 : Commit** (demander l'accord d'abord)

---

## Task 15 : Réécrire `ARCHITECTURE.md`

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1 : Constater le problème avant d'écrire**

```bash
grep -ci "lockstep\|znet" ARCHITECTURE.md
```
Expected avant : `0`. Le document décrit le streaming P2P — hôte, invité, capture de canvas, SimplePeer — alors que le mode par défaut d'une room est `lockstep` (`backend/src/websocket/room-handlers.ts:191`) et que c'est le seul activement développé. Un lecteur qui part de ce document se construit un modèle faux du produit.

- [ ] **Step 2 : Réécrire**

Plan du document :

1. **Vue d'ensemble** — émulation côté client dans tous les modes ; le serveur ne fait que signalisation, relais et persistance.
2. **Les quatre modes**, lockstep en tête comme mode par défaut. Pour chacun : le principe en trois lignes, le composant qui l'implémente, le module qui porte sa logique, et ce qu'il coûte.

   | Mode | Composant | Logique | Coût |
   |---|---|---|---|
   | `lockstep` (défaut) | `LockstepRoom.svelte` | `lib/znet/` | D frames de latence d'entrée, blocage franc si le réseau hoquette |
   | `single` | `SoloRoom.svelte` | `lib/znet/solo.ts` | — |
   | `streaming` | `P2PRoom.svelte` | `lib/multiplayer/streaming-mode.ts`, `lib/webrtc/` | l'invité subit la latence d'encodage, pas de savestate |
   | `dual` (alpha) | `P2PRoom.svelte` | `lib/multiplayer/dual-mode.ts`, `lib/netplay/` | peut diverger silencieusement |

3. **Le chemin lockstep en détail**, mais bref : renvoyer à `LOCKSTEP_NETPLAY.md` plutôt que le paraphraser. Nommer le découpage issu de cette passe — `session.ts` pour la machine à états et le transport, `pad-timeline.ts`, `link-metrics.ts`, `delay-control.ts`.
4. **Le serveur** — Express et ses routeurs, socket.io et ses six groupes de handlers, SQLite, Redis, l'amorçage en `bootstrap/`.
5. **Carte des répertoires**, reflétant l'arbre après cette passe.

Conserver les schémas ASCII existants du chemin WebRTC : ils sont justes pour le mode streaming, ils sont seulement mal placés comme description unique du produit. Les déplacer sous la section streaming.

- [ ] **Step 3 : Vérifier**

```bash
grep -ci "lockstep" ARCHITECTURE.md
```
Expected: un compte non nul, et le mot présent dans les deux cents premières lignes.

Vérifier que chaque fichier nommé dans le document existe :
```bash
grep -oE '(frontend|backend|core)/[a-zA-Z0-9/_.-]+\.(ts|svelte)' ARCHITECTURE.md | sort -u | while read f; do
  [ -e "$f" ] || echo "MANQUANT: $f"
done
```
Expected: aucune sortie. Une documentation qui nomme des fichiers disparus est pire que pas de documentation.

- [ ] **Step 4 : Vérification finale de bout en bout**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:all
cd backend && npx tsc --noEmit && cd ..
cd frontend && npx svelte-check --tsconfig ./tsconfig.json && npm run build && cd ..
node scripts/svelte-frozen-props.mjs $(find frontend/src -name '*.svelte' | sort)
find backend/src frontend/src core/*.ts -name '*.ts' -o -name '*.svelte' | \
  xargs wc -l 2>/dev/null | sort -rn | head -12
```

Expected, contre les critères d'acceptation du spec :
1. `test:all` vert, aucune assertion modifiée ;
2. `tsc` et `svelte-check` propres ;
3. build réussi ;
4. exactement les six sites réactifs de la référence ;
5. aucun fichier source applicatif au-dessus de 1 100 lignes hors `P2PRoom.svelte`, `simple-sync-manager.ts` et `ClientEmulator.svelte` ;
6. `ARCHITECTURE.md` décrit le mode par défaut ;
7. une session lockstep à deux joueurs démarre, tient, survit à une sauvegarde puis une reprise — vérifié dans l'application.

- [ ] **Step 5 : Commit** (demander l'accord d'abord)
