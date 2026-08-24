# Deux joueurs sur un canapé — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** le menu d'assignation des touches devient celui de deux joueurs locaux, sur un dessin de manette SNES cliquable, avec les manettes physiques assignées par joueur — et le port 2 se met à jouer en solo.

**Architecture:** toute la logique part dans trois modules `.ts` testables (`controls/binding.ts`, `znet/devices.ts`, `znet/input.ts`) ; trois composants Svelte se partagent l'affichage (`SnesPad` sans état, `PlayerControls` par joueur, `ControlsSettings` comme coquille) ; la config du compte passe de `KeyConfig` à `{version:2, p1, p2}` normalisée en lecture, et l'assignation des manettes vit dans le `localStorage`.

**Tech Stack:** SvelteKit 2 / Svelte 4, TypeScript, Express + better-sqlite3, tests `node:test` via `node --import tsx --test`, SVG inline.

**Spec:** `docs/superpowers/specs/2026-08-23-two-player-controls-design.md`

## Global Constraints

- **`node` n'est pas dans le `PATH`.** Préfixer chaque commande par `export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"`. Un `npm` nu est celui de Windows et échoue.
- **Travailler dans le worktree** `.claude/worktrees/controls-two-players`, branche `worktree-controls-two-players`. Ne jamais `cd` vers le dépôt principal.
- **Ne jamais `git add -A`** : un autre agent peut partager l'arbre. Staged par chemin, toujours. Les liens symboliques `node_modules` apparaissent comme non suivis et ne doivent jamais être committés.
- **Les commits de ce plan sont autorisés** sur la branche du worktree, et seulement là. Aucune fusion, aucun push sans accord explicite du propriétaire.
- **Nouveau fichier de test = une ligne à ajouter** au script `test:ui` de `package.json`, sinon `npm run test:all` ne le voit pas.
- **Le vocabulaire des codes est fixé** : clavier = `event.code` (`''` = non lié) ; manette = `PadButton<n>` / `PadAxis<n>Plus` / `PadAxis<n>Minus`, en **listes** (`[]` = non lié).
- **Les bits de pad viennent de `PAD`** (`frontend/src/lib/znet/protocol.ts:31`) : `B=1, Y=2, SELECT=4, START=8, UP=16, DOWN=32, LEFT=64, RIGHT=128, A=256, X=512, L=1024, R=2048`.
- **Seuil d'axe : `0.5`**, la valeur `AXIS_THRESHOLD` actuelle de `input.ts`.
- **i18n obligatoire** : toute chaîne visible passe par `t($language, 'clé')`, avec une entrée `en` **et** `fr` dans `frontend/src/lib/i18n/translations.ts`.

---

## Ordre et dépendances

```
1 ─ 2 ─ 3 ──┐
4 ──────────┼─ 5 ─┐
6 ──────────┘     ├─ 10 ─ 11 ─ 12
7 ─ 8 ─ 9 ────────┘
```

Les tâches 1 à 6 sont du `.ts` pur avec tests ; 7 à 9 l'interface ; 10 et 11 le câblage ; 12 la vérification dans l'app.

---

### Task 1: Le vocabulaire des codes et la normalisation de la config

**Files:**
- Create: `frontend/src/lib/controls/binding.ts`
- Test: `core/test/controls-config.test.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: `KeyConfig` depuis `frontend/src/lib/types.ts`
- Produces: `BUTTONS`, `Button`, `PadConfig`, `PlayerControls`, `ControlsConfig`, `DEFAULT_P1_KEYS`, `DEFAULT_P2_KEYS`, `STANDARD_PAD`, `defaultControlsConfig()`, `isPadCode(code: string): boolean`, `parsePadCode(code: string): PadCodeDescriptor | null`, `legacyToPadCode(code: string): string | null`, `normaliseControlsConfig(raw: unknown): ControlsConfig`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `core/test/controls-config.test.ts` :

```ts
/**
 * Normalisation de la config de contrôles.
 *
 * Ce module est la seule porte par laquelle une config entre dans le front :
 * une forme v1 venue de la base, une v2 déjà normalisée, ou n'importe quoi.
 * Une normalisation qui laisse passer un trou produit un joueur dont un
 * bouton ne répond pas, et rien en amont ne le rattrape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	BUTTONS,
	DEFAULT_P1_KEYS,
	DEFAULT_P2_KEYS,
	STANDARD_PAD,
	defaultControlsConfig,
	isPadCode,
	legacyToPadCode,
	normaliseControlsConfig,
	parsePadCode
} from '../../frontend/src/lib/controls/binding.js';

const V1 = {
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA',
	l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight'
};

test('les douze boutons SNES, et rien de plus', () => {
	assert.equal(BUTTONS.length, 12);
	assert.deepEqual([...BUTTONS].sort(), [
		'a', 'b', 'down', 'l', 'left', 'r', 'right', 'select', 'start', 'up', 'x', 'y'
	]);
});

test('les défauts des deux joueurs ne se croisent jamais', () => {
	const p1 = new Set(Object.values(DEFAULT_P1_KEYS));
	for (const code of Object.values(DEFAULT_P2_KEYS)) {
		assert.ok(!p1.has(code), `${code} est dans les deux jeux de défauts`);
	}
});

test('le mappage standard couvre la croix par les boutons ET par le stick', () => {
	// La table en dur qu'il remplace lisait les deux. Ne garder qu'un des deux
	// couperait le stick gauche sur toute manette XInput.
	assert.deepEqual(STANDARD_PAD.up, ['PadButton12', 'PadAxis1Minus']);
	assert.deepEqual(STANDARD_PAD.down, ['PadButton13', 'PadAxis1Plus']);
	assert.deepEqual(STANDARD_PAD.left, ['PadButton14', 'PadAxis0Minus']);
	assert.deepEqual(STANDARD_PAD.right, ['PadButton15', 'PadAxis0Plus']);
	assert.deepEqual(STANDARD_PAD.a, ['PadButton1']);
	assert.deepEqual(STANDARD_PAD.select, ['PadButton8']);
});

test('reconnaître et découper un code manette', () => {
	assert.ok(isPadCode('PadButton12'));
	assert.ok(isPadCode('PadAxis0Minus'));
	assert.ok(!isPadCode('KeyX'));
	assert.ok(!isPadCode('Gamepad0Button2'), 'un code legacy n’est pas un code manette');

	assert.deepEqual(parsePadCode('PadButton12'), { kind: 'button', index: 12 });
	assert.deepEqual(parsePadCode('PadAxis1Plus'), { kind: 'axis', index: 1, dir: 'plus' });
	assert.equal(parsePadCode('KeyX'), null);
});

test('les codes legacy perdent leur index de périphérique', () => {
	assert.equal(legacyToPadCode('Gamepad0Button2'), 'PadButton2');
	assert.equal(legacyToPadCode('Gamepad1Button11'), 'PadButton11');
	assert.equal(legacyToPadCode('Gamepad0Axis1Plus'), 'PadAxis1Plus');
	assert.equal(legacyToPadCode('KeyX'), null);
});

test('une KeyConfig nue devient un v2 complet', () => {
	const config = normaliseControlsConfig(V1);

	assert.equal(config.version, 2);
	assert.deepEqual(config.p1.keys, V1, 'les touches du J1 sont reprises telles quelles');
	assert.deepEqual(config.p1.pad, STANDARD_PAD, 'le J1 hérite du mappage standard');
	assert.deepEqual(config.p2.keys, DEFAULT_P2_KEYS, 'le J2 apparaît avec ses défauts');
	assert.deepEqual(config.p2.pad, STANDARD_PAD);
});

test('un code manette legacy migre vers la table manette et libère le clavier', () => {
	const config = normaliseControlsConfig({ ...V1, a: 'Gamepad0Button2' });

	assert.deepEqual(config.p1.pad.a, ['PadButton2'], 'la liaison passe côté manette');
	assert.equal(config.p1.keys.a, '', 'et l’emplacement clavier devient non lié');
	assert.deepEqual(config.p1.pad.b, STANDARD_PAD.b, 'les autres emplacements ne bougent pas');
});

test('un v2 traverse sans être réécrit, emplacements vidés compris', () => {
	const input = {
		version: 2,
		p1: { keys: { ...V1, l: '' }, pad: { ...STANDARD_PAD, l: [] } },
		p2: { keys: DEFAULT_P2_KEYS, pad: { ...STANDARD_PAD, a: ['PadButton7'] } }
	};
	const config = normaliseControlsConfig(input);

	assert.equal(config.p1.keys.l, '', 'un emplacement clavier vidé reste vide');
	assert.deepEqual(config.p1.pad.l, [], 'une liste vidée reste vide');
	assert.deepEqual(config.p2.pad.a, ['PadButton7'], 'une liaison choisie est conservée');
});

test('la normalisation est idempotente', () => {
	const once = normaliseControlsConfig(V1);
	assert.deepEqual(normaliseControlsConfig(once), once);
});

test('les clés manquantes sont complétées, la saleté est remplacée', () => {
	const partial = normaliseControlsConfig({ version: 2, p1: { keys: { a: 'KeyM' } } });
	assert.equal(partial.p1.keys.a, 'KeyM');
	assert.equal(partial.p1.keys.up, DEFAULT_P1_KEYS.up, 'le reste vient des défauts');
	assert.deepEqual(partial.p1.pad, STANDARD_PAD, 'une table pad absente vaut le standard');

	for (const junk of [null, undefined, 42, 'nope', [], {}, { version: 9 }]) {
		assert.deepEqual(
			normaliseControlsConfig(junk),
			defaultControlsConfig(),
			`${JSON.stringify(junk)} doit retomber sur les défauts`
		);
	}
});

test('les codes non-manette sont écartés de la table manette', () => {
	const config = normaliseControlsConfig({
		version: 2,
		p1: { keys: V1, pad: { ...STANDARD_PAD, a: ['KeyX', 'PadButton1', 7] } }
	});
	assert.deepEqual(config.p1.pad.a, ['PadButton1']);
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/controls-config.test.ts
```

Attendu : ÉCHEC, `Cannot find module '.../frontend/src/lib/controls/binding.js'`.

- [ ] **Step 3: Écrire `binding.ts`**

Créer `frontend/src/lib/controls/binding.ts` :

```ts
/**
 * Le vocabulaire des liaisons, et la porte d'entrée de toute config.
 *
 * Deux familles de codes qui ne se mélangent jamais dans la même table : les
 * `event.code` du clavier, et des codes manette relatifs au pad du joueur.
 * L'index du périphérique n'est plus dans la liaison - c'est ce qui permet de
 * rebrancher les manettes dans un autre ordre sans perdre son mappage, et de
 * donner la même liaison à deux joueurs sur deux pads différents.
 *
 * Tout ce qui vient de la base ou du réseau passe par `normaliseControlsConfig`
 * avant d'être lu. Rien d'autre n'a le droit de supposer une forme.
 */

import type { KeyConfig } from '$lib/types';

export const BUTTONS = [
	'up', 'down', 'left', 'right',
	'a', 'b', 'x', 'y',
	'l', 'r', 'start', 'select'
] as const;

export type Button = (typeof BUTTONS)[number];

/** Une liste de codes manette par bouton SNES. Liste vide = non lié. */
export type PadConfig = Record<Button, string[]>;

export interface PlayerControls {
	keys: KeyConfig;
	pad: PadConfig;
}

export interface ControlsConfig {
	version: 2;
	p1: PlayerControls;
	p2: PlayerControls;
}

export const DEFAULT_P1_KEYS: KeyConfig = {
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA',
	l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight'
};

/**
 * Le second joueur au clavier.
 *
 * Décrit par position physique - `event.code` ignore la disposition, et aucun
 * de ces codes n'est touché par la permutation AZERTY :
 *
 *     T Y          U I O        T=L  Y=R      I=haut  J=gauche
 *     G H          J K L        G=Y  H=X      K=bas   L=droite
 *     B N                       B=B  N=A      U=Select  O=Start
 *
 * Aucune intersection avec DEFAULT_P1_KEYS : deux joueurs au clavier sur la
 * même machine est le cas local le plus courant, et il doit marcher sans
 * qu'on touche à quoi que ce soit.
 */
export const DEFAULT_P2_KEYS: KeyConfig = {
	up: 'KeyI', down: 'KeyK', left: 'KeyJ', right: 'KeyL',
	a: 'KeyN', b: 'KeyB', x: 'KeyH', y: 'KeyG',
	l: 'KeyT', r: 'KeyY', start: 'KeyO', select: 'KeyU'
};

/**
 * Le mappage qu'une manette a avant que quiconque ne rebinde quoi que ce soit.
 *
 * C'est la table `GAMEPAD_BITS` de `znet/input.ts` rendue visible et
 * modifiable, aux axes près : l'ancienne lecture traitait la croix (boutons 12
 * à 15) *et* le stick gauche (axes 0 et 1) comme la croix directionnelle. Une
 * manette XInput rapporte les deux. N'en garder qu'un couperait le stick.
 */
export const STANDARD_PAD: PadConfig = {
	up: ['PadButton12', 'PadAxis1Minus'],
	down: ['PadButton13', 'PadAxis1Plus'],
	left: ['PadButton14', 'PadAxis0Minus'],
	right: ['PadButton15', 'PadAxis0Plus'],
	a: ['PadButton1'],
	b: ['PadButton0'],
	x: ['PadButton3'],
	y: ['PadButton2'],
	l: ['PadButton4'],
	r: ['PadButton5'],
	start: ['PadButton9'],
	select: ['PadButton8']
};

export type PadCodeDescriptor =
	| { kind: 'button'; index: number }
	| { kind: 'axis'; index: number; dir: 'plus' | 'minus' };

const PAD_BUTTON = /^PadButton(\d+)$/;
const PAD_AXIS = /^PadAxis(\d+)(Plus|Minus)$/;
const LEGACY_BUTTON = /^Gamepad\d+Button(\d+)$/;
const LEGACY_AXIS = /^Gamepad\d+Axis(\d+)(Plus|Minus)$/;

export function parsePadCode(code: string): PadCodeDescriptor | null {
	const button = PAD_BUTTON.exec(code);
	if (button) return { kind: 'button', index: Number(button[1]) };
	const axis = PAD_AXIS.exec(code);
	if (axis) return { kind: 'axis', index: Number(axis[1]), dir: axis[2] === 'Plus' ? 'plus' : 'minus' };
	return null;
}

export function isPadCode(code: string): boolean {
	return parsePadCode(code) !== null;
}

/**
 * Traduit une liaison de l'époque où l'index du périphérique était dedans.
 *
 * Jeter l'index est sans risque : `0` est la seule valeur que l'ancienne
 * capture pouvait réalistement produire, puisqu'elle renumérotait les pads
 * physiques à partir de zéro.
 */
export function legacyToPadCode(code: string): string | null {
	const button = LEGACY_BUTTON.exec(code);
	if (button) return `PadButton${button[1]}`;
	const axis = LEGACY_AXIS.exec(code);
	if (axis) return `PadAxis${axis[1]}${axis[2]}`;
	return null;
}

function clonePad(source: PadConfig): PadConfig {
	const out = {} as PadConfig;
	for (const button of BUTTONS) out[button] = [...source[button]];
	return out;
}

function defaultPlayer(keys: KeyConfig): PlayerControls {
	return { keys: { ...keys }, pad: clonePad(STANDARD_PAD) };
}

export function defaultControlsConfig(): ControlsConfig {
	return { version: 2, p1: defaultPlayer(DEFAULT_P1_KEYS), p2: defaultPlayer(DEFAULT_P2_KEYS) };
}

/** Vrai si l'objet a les douze boutons en chaînes - la forme v1. */
function looksLikeKeyConfig(raw: Record<string, unknown>): boolean {
	return BUTTONS.every((button) => typeof raw[button] === 'string');
}

/**
 * Une v1 : les codes clavier restent, les codes manette déménagent.
 *
 * Un code manette trouvé dans la table clavier ne peut pas y rester - rien ne
 * l'y lirait jamais - et l'emplacement clavier qu'il occupait devient non lié
 * plutôt que de recevoir un défaut que le joueur n'a pas choisi.
 */
function playerFromLegacyKeys(raw: Record<string, unknown>, defaults: KeyConfig): PlayerControls {
	const player = defaultPlayer(defaults);
	for (const button of BUTTONS) {
		const value = raw[button];
		if (typeof value !== 'string' || value === '') continue;
		const padCode = legacyToPadCode(value);
		if (padCode) {
			player.pad[button] = [padCode];
			player.keys[button] = '';
		} else {
			player.keys[button] = value;
		}
	}
	return player;
}

function normalisePlayer(raw: unknown, defaults: KeyConfig): PlayerControls {
	const source = (raw && typeof raw === 'object' ? raw : {}) as { keys?: unknown; pad?: unknown };
	const player = defaultPlayer(defaults);

	const rawKeys = (source.keys && typeof source.keys === 'object' ? source.keys : {}) as Record<string, unknown>;
	const rawPad = (source.pad && typeof source.pad === 'object' ? source.pad : null) as Record<string, unknown> | null;

	for (const button of BUTTONS) {
		if (rawPad) {
			const value = rawPad[button];
			if (Array.isArray(value)) {
				player.pad[button] = value.filter((code): code is string => typeof code === 'string' && isPadCode(code));
			} else if (typeof value === 'string' && isPadCode(value)) {
				player.pad[button] = [value];
			}
		}

		const key = rawKeys[button];
		if (typeof key !== 'string') continue;
		const migrated = legacyToPadCode(key);
		if (migrated) {
			player.pad[button] = [migrated];
			player.keys[button] = '';
		} else {
			player.keys[button] = key;
		}
	}

	return player;
}

/**
 * Fait entrer n'importe quoi dans la forme v2.
 *
 * Trois entrées possibles et une seule sortie : une v2 (normalisée emplacement
 * par emplacement), une `KeyConfig` nue de l'époque à un joueur, ou tout le
 * reste - qui vaut les défauts. Idempotente, ce que le test exige : elle est
 * appelée à chaque lecture, y compris sur sa propre sortie.
 */
export function normaliseControlsConfig(raw: unknown): ControlsConfig {
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		const source = raw as Record<string, unknown>;
		if (source.version === 2) {
			return {
				version: 2,
				p1: normalisePlayer(source.p1, DEFAULT_P1_KEYS),
				p2: normalisePlayer(source.p2, DEFAULT_P2_KEYS)
			};
		}
		if (looksLikeKeyConfig(source)) {
			return {
				version: 2,
				p1: playerFromLegacyKeys(source, DEFAULT_P1_KEYS),
				p2: defaultPlayer(DEFAULT_P2_KEYS)
			};
		}
	}
	return defaultControlsConfig();
}
```

- [ ] **Step 4: Lancer le test pour vérifier qu'il passe**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/controls-config.test.ts
```

Attendu : les 11 tests du fichier passent.

- [ ] **Step 5: Déclarer le fichier de test**

Dans `package.json`, ajouter ` core/test/controls-config.test.ts` à la fin de la liste du script `test:ui`, puis :

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:ui 2>&1 | tail -5
```

Attendu : `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/controls/binding.ts core/test/controls-config.test.ts package.json
git commit -m "Give the controls config a shape with two players in it"
```

---

### Task 2: Décrire un code pour l'afficher

**Files:**
- Modify: `frontend/src/lib/controls/binding.ts`
- Test: `core/test/controls-config.test.ts`

**Interfaces:**
- Consumes: `parsePadCode` (Task 1)
- Produces: `describeCode(code: string): CodeDescription`, `shortLabel(code: string): string`, `shortLabelList(codes: string[]): string`

`CodeDescription` est un descripteur *sans mots* : la traduction est le travail du composant, qui a accès au store de langue. Un module pur ne peut pas traduire, et un module qui traduirait ne serait pas testable ici.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter à la fin de `core/test/controls-config.test.ts` :

```ts
/* ------------------------------------------------------------- affichage */

test('un code se décrit sans avoir besoin de mots', () => {
	assert.deepEqual(describeCode('KeyX'), { kind: 'keyboard', code: 'KeyX' });
	assert.deepEqual(describeCode('PadButton2'), { kind: 'padButton', index: 2 });
	assert.deepEqual(describeCode('PadAxis0Minus'), { kind: 'padAxis', index: 0, dir: 'minus' });
	assert.deepEqual(describeCode(''), { kind: 'unbound' });
});

test('les formes courtes tiennent sur un bouton', () => {
	assert.equal(shortLabel('KeyX'), 'X');
	assert.equal(shortLabel('Digit1'), '1');
	assert.equal(shortLabel('ArrowUp'), '↑');
	assert.equal(shortLabel('ArrowLeft'), '←');
	assert.equal(shortLabel('Enter'), '⏎');
	assert.equal(shortLabel('Space'), '␣');
	assert.equal(shortLabel('ShiftRight'), '⇧D');
	assert.equal(shortLabel('ShiftLeft'), '⇧G');
	assert.equal(shortLabel('ControlLeft'), '⌃G');
	assert.equal(shortLabel('AltRight'), '⌥D');
	assert.equal(shortLabel('Escape'), 'Esc', 'un code inconnu du dictionnaire garde un nom lisible');
	assert.equal(shortLabel('PadButton2'), 'B2');
	assert.equal(shortLabel('PadAxis0Minus'), 'A0−');
	assert.equal(shortLabel('PadAxis1Plus'), 'A1+');
	assert.equal(shortLabel(''), '—');
});

test('une liste dit son premier code et compte le reste', () => {
	assert.equal(shortLabelList([]), '—');
	assert.equal(shortLabelList(['PadButton12']), 'B12');
	assert.equal(shortLabelList(['PadButton12', 'PadAxis1Minus']), 'B12 +1');
	assert.equal(shortLabelList(['PadButton12', 'PadAxis1Minus', 'PadButton3']), 'B12 +2');
});
```

Et compléter l'import en haut du fichier :

```ts
import {
	BUTTONS,
	DEFAULT_P1_KEYS,
	DEFAULT_P2_KEYS,
	STANDARD_PAD,
	defaultControlsConfig,
	describeCode,
	isPadCode,
	legacyToPadCode,
	normaliseControlsConfig,
	parsePadCode,
	shortLabel,
	shortLabelList
} from '../../frontend/src/lib/controls/binding.js';
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/controls-config.test.ts
```

Attendu : ÉCHEC, `describeCode is not a function`.

- [ ] **Step 3: Écrire l'implémentation**

Ajouter à `frontend/src/lib/controls/binding.ts` :

```ts
/* ------------------------------------------------------------- affichage */

export type CodeDescription =
	| { kind: 'keyboard'; code: string }
	| { kind: 'padButton'; index: number }
	| { kind: 'padAxis'; index: number; dir: 'plus' | 'minus' }
	| { kind: 'unbound' };

/**
 * Ce qu'un code est, sans dire comment on le nomme.
 *
 * Le composant traduit ; ce module reste testable sans store de langue.
 */
export function describeCode(code: string): CodeDescription {
	if (!code) return { kind: 'unbound' };
	const pad = parsePadCode(code);
	if (pad) {
		return pad.kind === 'button'
			? { kind: 'padButton', index: pad.index }
			: { kind: 'padAxis', index: pad.index, dir: pad.dir };
	}
	return { kind: 'keyboard', code };
}

/** Les touches dont le nom court n'est pas déductible du code. */
const SHORT_KEYS: Record<string, string> = {
	ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
	Enter: '⏎', NumpadEnter: '⏎', Space: '␣', Tab: '⇥', Backspace: '⌫', Escape: 'Esc',
	ShiftLeft: '⇧G', ShiftRight: '⇧D',
	ControlLeft: '⌃G', ControlRight: '⌃D',
	AltLeft: '⌥G', AltRight: '⌥D'
};

/**
 * Ce qui s'écrit sur un bouton du dessin.
 *
 * Court par obligation : dans le panneau de pause, le dessin fait 280 px de
 * large, et un libellé de plus de trois caractères n'y tient pas. La forme
 * longue existe, dans l'`aria-label`.
 */
export function shortLabel(code: string): string {
	const described = describeCode(code);
	switch (described.kind) {
		case 'unbound':
			return '—';
		case 'padButton':
			return `B${described.index}`;
		case 'padAxis':
			return `A${described.index}${described.dir === 'minus' ? '−' : '+'}`;
		case 'keyboard': {
			const known = SHORT_KEYS[described.code];
			if (known) return known;
			if (described.code.startsWith('Key')) return described.code.slice(3);
			if (described.code.startsWith('Digit')) return described.code.slice(5);
			if (described.code.startsWith('Numpad')) return `N${described.code.slice(6)}`;
			return described.code;
		}
	}
}

export function shortLabelList(codes: string[]): string {
	const bound = codes.filter((code) => code !== '');
	if (bound.length === 0) return '—';
	const extra = bound.length - 1;
	return extra > 0 ? `${shortLabel(bound[0])} +${extra}` : shortLabel(bound[0]);
}
```

- [ ] **Step 4: Lancer le test pour vérifier qu'il passe**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/controls-config.test.ts
```

Attendu : 14 tests, 0 échec (les 11 de la Task 1 plus les 3 d'ici).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/controls/binding.ts core/test/controls-config.test.ts
git commit -m "Describe a binding without naming it"
```

---

### Task 3: Les conflits, qui n'existent que dans une source partagée

**Files:**
- Modify: `frontend/src/lib/controls/binding.ts`
- Test: `core/test/controls-config.test.ts`

**Interfaces:**
- Consumes: `ControlsConfig`, `Button`, `BUTTONS` (Task 1)
- Produces: `InputSources` (`{ keyboard: boolean; pads: PadSelection }`), `PadSelection` (`number[] | 'all'`), `ConflictOwner`, `ConflictMap`, `ConflictReport`, `findConflicts(config, sources): ConflictReport`

C'est le cœur du morceau : la même égalité de codes est un conflit ou non selon que les deux joueurs peuvent l'atteindre.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter à `core/test/controls-config.test.ts` :

```ts
/* -------------------------------------------------------------- conflits */

const BOTH_KEYBOARD = {
	p1: { keyboard: true, pads: [] as number[] },
	p2: { keyboard: true, pads: [] as number[] }
};

function config(p1: unknown, p2: unknown = {}) {
	return normaliseControlsConfig({ version: 2, p1, p2 });
}

test('deux boutons du même joueur sur la même touche : conflit', () => {
	const report = findConflicts(
		config({ keys: { ...DEFAULT_P1_KEYS, b: 'KeyX' } }),
		BOTH_KEYBOARD
	);

	assert.deepEqual([...report.p1.keys.keys()].sort(), ['a', 'b']);
	assert.deepEqual(report.p1.keys.get('a'), [{ player: 1, button: 'b' }]);
	assert.deepEqual(report.p1.keys.get('b'), [{ player: 1, button: 'a' }]);
	assert.equal(report.count, 2);
});

test('un doublon est signalé même quand le joueur est inactif', () => {
	// Il le rebranchera, et découvrir le conflit à ce moment-là serait pire.
	const report = findConflicts(config({ keys: { ...DEFAULT_P1_KEYS, b: 'KeyX' } }), {
		p1: { keyboard: false, pads: [] },
		p2: { keyboard: false, pads: [] }
	});
	assert.equal(report.p1.keys.size, 2);
});

test('deux joueurs au clavier sur la même touche : conflit', () => {
	const report = findConflicts(
		config({ keys: DEFAULT_P1_KEYS }, { keys: { ...DEFAULT_P2_KEYS, a: 'KeyX' } }),
		BOTH_KEYBOARD
	);

	assert.deepEqual(report.p1.keys.get('a'), [{ player: 2, button: 'a' }]);
	assert.deepEqual(report.p2.keys.get('a'), [{ player: 1, button: 'a' }]);
});

test('même touche, mais le J2 n’a pas le clavier : aucun conflit', () => {
	const report = findConflicts(
		config({ keys: DEFAULT_P1_KEYS }, { keys: { ...DEFAULT_P2_KEYS, a: 'KeyX' } }),
		{ p1: { keyboard: true, pads: [] }, p2: { keyboard: false, pads: [] } }
	);

	assert.equal(report.count, 0, 'la touche du J2 est inatteignable');
});

test('même bouton manette sur DEUX manettes différentes : aucun conflit', () => {
	// La raison d'être du modèle par périphérique. Sans cette règle, deux
	// joueurs avec le mappage standard seraient en conflit sur les douze
	// boutons, et rien ne pourrait plus être sauvegardé.
	const report = findConflicts(config({ keys: DEFAULT_P1_KEYS }, { keys: DEFAULT_P2_KEYS }), {
		p1: { keyboard: true, pads: [0] },
		p2: { keyboard: false, pads: [1] }
	});

	assert.equal(report.count, 0);
});

test('même bouton manette sur la MÊME manette : conflit', () => {
	const report = findConflicts(config({ keys: DEFAULT_P1_KEYS }, { keys: DEFAULT_P2_KEYS }), {
		p1: { keyboard: true, pads: [0] },
		p2: { keyboard: false, pads: [0] }
	});

	assert.equal(report.p1.pad.size, 12, 'les douze emplacements se marchent dessus');
	assert.deepEqual(report.p1.pad.get('a'), [{ player: 2, button: 'a' }]);
});

test("'all' intersecte tout ce qui est connecté", () => {
	const report = findConflicts(config({ keys: DEFAULT_P1_KEYS }, { keys: DEFAULT_P2_KEYS }), {
		p1: { keyboard: true, pads: 'all' },
		p2: { keyboard: false, pads: [1] }
	});

	assert.ok(report.count > 0, "'all' inclut le pad 1");
});

test('un doublon manette chez un seul joueur : conflit', () => {
	const report = findConflicts(
		config({ keys: DEFAULT_P1_KEYS, pad: { ...STANDARD_PAD, b: ['PadButton1'] } }),
		{ p1: { keyboard: true, pads: [0] }, p2: { keyboard: false, pads: [] } }
	);

	assert.deepEqual([...report.p1.pad.keys()].sort(), ['a', 'b']);
});

test('les emplacements non liés ne sont jamais en conflit', () => {
	const report = findConflicts(
		config({ keys: { ...DEFAULT_P1_KEYS, l: '', r: '' }, pad: { ...STANDARD_PAD, l: [], r: [] } }),
		BOTH_KEYBOARD
	);

	assert.equal(report.count, 0, 'trois emplacements vides ne se ressemblent pas');
});
```

Compléter l'import avec `findConflicts`.

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/controls-config.test.ts
```

Attendu : ÉCHEC, `findConflicts is not a function`.

- [ ] **Step 3: Écrire l'implémentation**

Ajouter à `frontend/src/lib/controls/binding.ts` :

```ts
/* -------------------------------------------------------------- conflits */

/** Les pads qu'un joueur écoute. `'all'` = tous les connectés. */
export type PadSelection = number[] | 'all';

export interface InputSources {
	keyboard: boolean;
	pads: PadSelection;
}

export interface ConflictOwner {
	player: 1 | 2;
	button: Button;
}

/** Par bouton en conflit : les autres liaisons qui lui prennent son code. */
export type ConflictMap = Map<Button, ConflictOwner[]>;

export interface ConflictReport {
	p1: { keys: ConflictMap; pad: ConflictMap };
	p2: { keys: ConflictMap; pad: ConflictMap };
	/** Nombre d'emplacements en conflit, toutes tables confondues. */
	count: number;
}

function padsOverlap(a: PadSelection, b: PadSelection): boolean {
	if (a === 'all' || b === 'all') {
		// `'all'` n'est vide que s'il n'y a aucun pad, et dans ce cas l'autre
		// sélection est vide aussi : se croire non chevauchant serait faux.
		return a === 'all' ? b === 'all' || b.length > 0 : a.length > 0;
	}
	return a.some((index) => b.includes(index));
}

/** Toutes les liaisons d'une table, une entrée par code. */
function entries(codesOf: (button: Button) => string[], player: 1 | 2) {
	const out: Array<{ code: string; owner: ConflictOwner }> = [];
	for (const button of BUTTONS) {
		for (const code of codesOf(button)) {
			if (code) out.push({ code, owner: { player, button } });
		}
	}
	return out;
}

function emptyMaps() {
	return { keys: new Map() as ConflictMap, pad: new Map() as ConflictMap };
}

/**
 * Qui se marche sur les pieds, et pour qui c'est un problème.
 *
 * Deux règles, et la seconde est celle qui compte :
 *
 * - à l'intérieur d'un joueur, un code en double est toujours un conflit,
 *   même si ce joueur est inactif ;
 * - entre joueurs, un code partagé n'est un conflit que si les deux peuvent
 *   l'atteindre - le clavier des deux côtés, ou des ensembles de pads qui
 *   s'intersectent. Sans cette seconde règle, deux joueurs sur le mappage
 *   standard seraient en conflit sur leurs douze boutons et plus rien ne
 *   pourrait être sauvegardé.
 */
export function findConflicts(
	config: ControlsConfig,
	sources: { p1: InputSources; p2: InputSources }
): ConflictReport {
	const report: ConflictReport = { p1: emptyMaps(), p2: emptyMaps(), count: 0 };

	const tables = [
		{
			table: 'keys' as const,
			shared: sources.p1.keyboard && sources.p2.keyboard,
			rows: [
				...entries((b) => [config.p1.keys[b]], 1),
				...entries((b) => [config.p2.keys[b]], 2)
			]
		},
		{
			table: 'pad' as const,
			shared: padsOverlap(sources.p1.pads, sources.p2.pads),
			rows: [
				...entries((b) => config.p1.pad[b], 1),
				...entries((b) => config.p2.pad[b], 2)
			]
		}
	];

	for (const { table, shared, rows } of tables) {
		const byCode = new Map<string, ConflictOwner[]>();
		for (const { code, owner } of rows) {
			const list = byCode.get(code);
			if (list) list.push(owner);
			else byCode.set(code, [owner]);
		}

		for (const owners of byCode.values()) {
			for (const owner of owners) {
				const others = owners.filter(
					(other) => other !== owner && (other.player === owner.player || shared)
				);
				if (others.length === 0) continue;
				const side = owner.player === 1 ? report.p1 : report.p2;
				// On accumule : un bouton dont la liste manette contient deux
				// codes peut entrer en conflit deux fois, et écraser l'entrée
				// précédente perdrait la moitié du message. Dédoublonné par
				// (joueur, bouton), sinon le même coupable serait cité deux fois.
				const merged = [...(side[table].get(owner.button) ?? []), ...others];
				const seen = new Set<string>();
				side[table].set(
					owner.button,
					merged.filter((other) => {
						const tag = `${other.player}:${other.button}`;
						if (seen.has(tag)) return false;
						seen.add(tag);
						return true;
					})
				);
			}
		}
	}

	report.count =
		report.p1.keys.size + report.p1.pad.size + report.p2.keys.size + report.p2.pad.size;
	return report;
}
```

- [ ] **Step 4: Lancer le test pour vérifier qu'il passe**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/controls-config.test.ts
```

Attendu : 23 tests, 0 échec (les 14 précédents plus les 9 d'ici).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/controls/binding.ts core/test/controls-config.test.ts
git commit -m "A conflict only exists inside a shared source"
```

---

### Task 4: L'assignation et la résolution des périphériques

**Files:**
- Create: `frontend/src/lib/znet/devices.ts`
- Test: `core/test/input-devices.test.ts`
- Modify: `package.json` (script `test:ui`)

**Interfaces:**
- Consumes: `InputSources`, `PadSelection` depuis `controls/binding.ts` (Task 3)
- Produces: `GamepadRef`, `GamepadAssignment`, `Assignment`, `Assignments`, `PadInfo`, `DEVICES_STORAGE_KEY`, `LEGACY_SOURCE_KEY`, `DEFAULT_ASSIGNMENTS`, `defaultAssignments()`, `connectedPads(nav?): PadInfo[]`, `padDisplayName(id: string): string`, `loadAssignments(storage): Assignments`, `saveAssignments(storage, a): void`, `resolveSources(a, pads): { p1: InputSources; p2: InputSources }`, `isPlayerActive(a: Assignment): boolean`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `core/test/input-devices.test.ts` :

```ts
/**
 * Assignation des manettes aux joueurs.
 *
 * Deux joueurs sur une machine ne sont séparés que par ça. Une résolution qui
 * donne le même pad aux deux produit une manette qui pilote les deux ports -
 * exactement le symptôme qu'on vient corriger - et une résolution qui n'en
 * donne à personne produit un joueur muet sans message d'erreur.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	DEVICES_STORAGE_KEY,
	LEGACY_SOURCE_KEY,
	connectedPads,
	defaultAssignments,
	isPlayerActive,
	loadAssignments,
	padDisplayName,
	resolveSources,
	saveAssignments
} from '../../frontend/src/lib/znet/devices.js';

/** Un `localStorage` de test : la même API, en mémoire. */
function fakeStorage(seed: Record<string, string> = {}) {
	const map = new Map(Object.entries(seed));
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		clear: () => map.clear(),
		key: (i: number) => [...map.keys()][i] ?? null,
		get length() {
			return map.size;
		}
	} as Storage;
}

const PADS = [
	{ index: 0, id: '8BitDo SN30 (Vendor: 2dc8 Product: 6001)' },
	{ index: 1, id: 'Xbox Wireless Controller (Vendor: 045e Product: 02fd)' }
];

test('les défauts reproduisent le solo actuel', () => {
	const a = defaultAssignments();
	assert.deepEqual(a.p1, { keyboard: true, gamepad: 'auto' });
	assert.deepEqual(a.p2, { keyboard: false, gamepad: null });
	assert.ok(isPlayerActive(a.p1));
	assert.ok(!isPlayerActive(a.p2), 'le J2 est muet tant qu’il n’a pas de périphérique');
});

test('un joueur devient actif dès qu’il a un périphérique', () => {
	assert.ok(isPlayerActive({ keyboard: true, gamepad: null }));
	assert.ok(isPlayerActive({ keyboard: false, gamepad: 'auto' }));
	assert.ok(isPlayerActive({ keyboard: false, gamepad: { id: 'x', index: 0 } }));
	assert.ok(!isPlayerActive({ keyboard: false, gamepad: null }));
});

test("un joueur seul en 'auto' lit tous les pads, comme aujourd’hui", () => {
	const sources = resolveSources(defaultAssignments(), PADS);
	assert.deepEqual(sources.p1.pads, [0, 1]);
	assert.equal(sources.p1.keyboard, true);
	assert.deepEqual(sources.p2.pads, []);
	assert.equal(sources.p2.keyboard, false);
});

test("'auto' cesse de lire le pad revendiqué par l’autre joueur", () => {
	// Le symptôme d'origine : sans ça, la manette du J2 pilote aussi le J1.
	const sources = resolveSources(
		{
			p1: { keyboard: true, gamepad: 'auto' },
			p2: { keyboard: false, gamepad: { id: PADS[1].id, index: 1 } }
		},
		PADS
	);

	assert.deepEqual(sources.p1.pads, [0]);
	assert.deepEqual(sources.p2.pads, [1]);
});

test('un pad se retrouve par son id, même si son index a changé', () => {
	const moved = [{ index: 3, id: PADS[0].id }];
	const sources = resolveSources(
		{
			p1: { keyboard: true, gamepad: { id: PADS[0].id, index: 0 } },
			p2: { keyboard: false, gamepad: null }
		},
		moved
	);

	assert.deepEqual(sources.p1.pads, [3], 'l’id passe avant l’index');
});

test('l’index sert de repli quand l’id ne dit rien', () => {
	// Deux manettes identiques partagent le même id : il faut bien les séparer.
	const twins = [
		{ index: 0, id: 'Generic USB Gamepad' },
		{ index: 1, id: 'Generic USB Gamepad' }
	];
	const sources = resolveSources(
		{
			p1: { keyboard: false, gamepad: { id: 'Autre chose', index: 1 } },
			p2: { keyboard: false, gamepad: null }
		},
		twins
	);

	assert.deepEqual(sources.p1.pads, [1]);
});

test('un pad débranché ne donne rien du tout', () => {
	const sources = resolveSources(
		{
			p1: { keyboard: true, gamepad: { id: 'Parti', index: 7 } },
			p2: { keyboard: false, gamepad: null }
		},
		PADS
	);

	assert.deepEqual(sources.p1.pads, [], 'et surtout pas le premier pad venu');
});

test('deux revendications sur le même pad ne sont pas arbitrées', () => {
	// Les deux le lisent ; c'est la détection de conflits qui le dira à
	// l'écran. Trancher ici rendrait un joueur muet sans explication.
	const sources = resolveSources(
		{
			p1: { keyboard: false, gamepad: { id: PADS[0].id, index: 0 } },
			p2: { keyboard: false, gamepad: { id: PADS[0].id, index: 0 } }
		},
		PADS
	);

	assert.deepEqual(sources.p1.pads, [0]);
	assert.deepEqual(sources.p2.pads, [0]);
});

test('un aller-retour par le stockage conserve tout', () => {
	const storage = fakeStorage();
	const assignments = {
		p1: { keyboard: false, gamepad: { id: PADS[0].id, index: 0 } },
		p2: { keyboard: true, gamepad: { id: PADS[1].id, index: 1 } }
	};
	saveAssignments(storage, assignments);
	assert.deepEqual(loadAssignments(storage), assignments);
});

test('l’ancienne clé est migrée puis effacée', () => {
	for (const [legacy, expected] of [
		['auto', 'auto'],
		['off', null],
		['2', { id: '', index: 2 }]
	] as const) {
		const storage = fakeStorage({ [LEGACY_SOURCE_KEY]: legacy });
		const assignments = loadAssignments(storage);

		assert.deepEqual(assignments.p1.gamepad, expected, `${legacy} mal migré`);
		assert.equal(assignments.p1.keyboard, true);
		assert.deepEqual(assignments.p2, { keyboard: false, gamepad: null });
		assert.equal(storage.getItem(LEGACY_SOURCE_KEY), null, 'l’ancienne clé disparaît');
		assert.ok(storage.getItem(DEVICES_STORAGE_KEY), 'la nouvelle est écrite');
	}
});

test('une ancienne valeur illisible retombe sur les défauts', () => {
	const storage = fakeStorage({ [LEGACY_SOURCE_KEY]: 'n’importe quoi' });
	assert.deepEqual(loadAssignments(storage).p1.gamepad, 'auto');
});

test('un stockage vide ou corrompu donne les défauts', () => {
	assert.deepEqual(loadAssignments(fakeStorage()), defaultAssignments());
	assert.deepEqual(
		loadAssignments(fakeStorage({ [DEVICES_STORAGE_KEY]: '{ pas du json' })),
		defaultAssignments()
	);
	assert.deepEqual(
		loadAssignments(fakeStorage({ [DEVICES_STORAGE_KEY]: '{"p1":{"gamepad":"n\'importe"}}' })),
		defaultAssignments()
	);
});

test('le nom affiché d’un pad perd son identifiant USB', () => {
	assert.equal(padDisplayName(PADS[0].id), '8BitDo SN30');
	assert.equal(padDisplayName('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'Xbox 360 Controller');
	assert.equal(padDisplayName('  '), '');
});

test('énumérer les pads survit à l’absence d’API', () => {
	assert.deepEqual(connectedPads({} as Navigator), []);
	assert.deepEqual(
		connectedPads({
			getGamepads: () => [
				{ index: 0, id: 'Un pad', connected: true },
				null,
				{ index: 2, id: 'Virtual Gamepad 1', connected: true },
				{ index: 3, id: 'Débranché', connected: false }
			]
		} as unknown as Navigator),
		[{ index: 0, id: 'Un pad' }],
		'les pads virtuels et déconnectés ne comptent pas'
	);
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/input-devices.test.ts
```

Attendu : ÉCHEC, module introuvable.

- [ ] **Step 3: Écrire l'implémentation**

Créer `frontend/src/lib/znet/devices.ts` :

```ts
/**
 * Qui tient quoi.
 *
 * Deux joueurs sur une machine ne sont séparés que par cette assignation, et
 * elle vit dans le `localStorage` plutôt que sur le compte : quelles manettes
 * sont branchées est une propriété du poste, pas de l'utilisateur. Le même
 * compte sur le PC du salon et sur le portable n'a pas le même matériel.
 *
 * Le collecteur d'entrées, lui, ne connaît que des `InputSources` déjà
 * résolues - un booléen clavier et une liste d'index. Il ignore tout de
 * l'assignation, et c'est ce qui le laisse testable.
 */

import type { InputSources } from '$lib/controls/binding';

export type GamepadRef = { id: string; index: number };
export type GamepadAssignment = 'auto' | GamepadRef | null;

export interface Assignment {
	keyboard: boolean;
	gamepad: GamepadAssignment;
}

export interface Assignments {
	p1: Assignment;
	p2: Assignment;
}

export interface PadInfo {
	index: number;
	id: string;
}

export const DEVICES_STORAGE_KEY = 'psnes-input-devices';
export const LEGACY_SOURCE_KEY = 'psnes-gamepad-source';

/**
 * Le J1 au clavier et sur tout ce qui est libre, le J2 muet.
 *
 * C'est exactement le comportement solo actuel, et c'est voulu : un joueur
 * seul ne doit rien remarquer de ce changement.
 */
export function defaultAssignments(): Assignments {
	return {
		p1: { keyboard: true, gamepad: 'auto' },
		p2: { keyboard: false, gamepad: null }
	};
}

export const DEFAULT_ASSIGNMENTS = defaultAssignments();

/** Un joueur joue dès qu'il a de quoi appuyer. C'est toute l'activation. */
export function isPlayerActive(assignment: Assignment): boolean {
	return assignment.keyboard || assignment.gamepad !== null;
}

/** Les pads réels que le navigateur rapporte. Les pads tactiles ne comptent pas. */
export function connectedPads(nav: Navigator | undefined = globalThis.navigator): PadInfo[] {
	if (!nav?.getGamepads) return [];
	const out: PadInfo[] = [];
	for (const pad of nav.getGamepads()) {
		if (!pad?.connected) continue;
		if (pad.id.includes('Virtual Gamepad')) continue;
		out.push({ index: pad.index, id: pad.id });
	}
	return out;
}

/** « 8BitDo SN30 (Vendor: 2dc8 …) » devient « 8BitDo SN30 ». */
export function padDisplayName(id: string): string {
	return id.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function normaliseGamepad(raw: unknown): GamepadAssignment | undefined {
	if (raw === null) return null;
	if (raw === 'auto') return 'auto';
	if (raw && typeof raw === 'object') {
		const ref = raw as Record<string, unknown>;
		if (typeof ref.id === 'string' && typeof ref.index === 'number') {
			return { id: ref.id, index: ref.index };
		}
	}
	return undefined;
}

function normaliseAssignment(raw: unknown, fallback: Assignment): Assignment {
	const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const gamepad = normaliseGamepad(source.gamepad);
	if (gamepad === undefined) return { ...fallback };
	return {
		keyboard: typeof source.keyboard === 'boolean' ? source.keyboard : fallback.keyboard,
		gamepad
	};
}

/**
 * Traduit `psnes-gamepad-source`, la clé d'avant.
 *
 * Elle ne connaissait qu'un joueur et une source. Le J2 arrive donc muet, ce
 * qui est le bon défaut : personne n'a demandé un second joueur.
 */
function migrateLegacy(storage: Storage): Assignments | null {
	const legacy = storage.getItem(LEGACY_SOURCE_KEY);
	if (legacy === null) return null;

	let gamepad: GamepadAssignment = 'auto';
	if (legacy === 'off') gamepad = null;
	else if (legacy !== 'auto') {
		const index = Number(legacy);
		if (Number.isInteger(index) && index >= 0) gamepad = { id: '', index };
	}

	const assignments: Assignments = {
		p1: { keyboard: true, gamepad },
		p2: { keyboard: false, gamepad: null }
	};
	storage.setItem(DEVICES_STORAGE_KEY, JSON.stringify(assignments));
	storage.removeItem(LEGACY_SOURCE_KEY);
	return assignments;
}

export function loadAssignments(storage: Storage): Assignments {
	const raw = storage.getItem(DEVICES_STORAGE_KEY);
	if (raw !== null) {
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const defaults = defaultAssignments();
			return {
				p1: normaliseAssignment(parsed.p1, defaults.p1),
				p2: normaliseAssignment(parsed.p2, defaults.p2)
			};
		} catch {
			// Une clé illisible n'est pas une raison de refuser de jouer.
		}
	}
	return migrateLegacy(storage) ?? defaultAssignments();
}

export function saveAssignments(storage: Storage, assignments: Assignments): void {
	storage.setItem(DEVICES_STORAGE_KEY, JSON.stringify(assignments));
}

/**
 * Le pad qu'une revendication explicite désigne, s'il est là.
 *
 * L'id d'abord : il survit au rebranchement, l'index non. L'index en repli :
 * deux manettes identiques partagent le même id.
 */
function resolveExplicit(assignment: GamepadAssignment, pads: PadInfo[]): number[] {
	if (assignment === null || assignment === 'auto') return [];
	const byId = pads.find((pad) => pad.id !== '' && pad.id === assignment.id);
	if (byId) return [byId.index];
	const byIndex = pads.find((pad) => pad.index === assignment.index);
	return byIndex ? [byIndex.index] : [];
}

/**
 * Ce que chaque joueur écoute, en deux temps.
 *
 * Les revendications explicites d'abord, chacune de son côté, puis `'auto'`
 * prend tout ce que l'autre joueur n'a pas pris. L'ordre est ce qui empêche la
 * définition d'être circulaire, et la redéfinition d'`'auto'` est ce qui
 * empêche une manette de piloter deux ports : pour un joueur seul, « tout ce
 * qui reste » vaut « tout », donc rien ne change.
 */
export function resolveSources(
	assignments: Assignments,
	pads: PadInfo[]
): { p1: InputSources; p2: InputSources } {
	const claimed = {
		p1: resolveExplicit(assignments.p1.gamepad, pads),
		p2: resolveExplicit(assignments.p2.gamepad, pads)
	};
	const unclaimedBy = (theirs: number[]) =>
		pads.map((pad) => pad.index).filter((index) => !theirs.includes(index));

	return {
		p1: {
			keyboard: assignments.p1.keyboard,
			pads: assignments.p1.gamepad === 'auto' ? unclaimedBy(claimed.p2) : claimed.p1
		},
		p2: {
			keyboard: assignments.p2.keyboard,
			pads: assignments.p2.gamepad === 'auto' ? unclaimedBy(claimed.p1) : claimed.p2
		}
	};
}
```

- [ ] **Step 4: Lancer le test pour vérifier qu'il passe**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/input-devices.test.ts
```

Attendu : 14 tests, 0 échec.

- [ ] **Step 5: Déclarer le fichier et lancer la suite**

Ajouter ` core/test/input-devices.test.ts` au script `test:ui` de `package.json`, puis :

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:ui 2>&1 | tail -5
```

Attendu : `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/znet/devices.ts core/test/input-devices.test.ts package.json
git commit -m "Assign a controller to a player, not an index to a binding"
```

---

### Task 5: `InputCollector` lit enfin la config manette

**Files:**
- Modify: `frontend/src/lib/znet/input.ts` (réécriture de la classe)
- Modify: `frontend/src/lib/znet/index.ts:52`
- Test: `core/test/input.test.ts` (réécriture des constructions + nouveaux tests)

**Interfaces:**
- Consumes: `PlayerControls`, `InputSources`, `PadSelection`, `parsePadCode`, `STANDARD_PAD`, `BUTTONS` (Tasks 1–3)
- Produces: `new InputCollector(controls: PlayerControls, sources?: InputSources)`, `setControls(controls: PlayerControls): void`, `setSources(sources: InputSources): void`, `getSources(): InputSources`, `read(): PadMask`, `attach(target?)`, `detach(target?)`

Le collecteur ne rend qu'un masque. L'écran de config, lui, a besoin des codes bruts pour alimenter `CaptureGate`, donc il sonde lui-même et en déduit les boutons allumés — donner au collecteur une méthode « boutons enfoncés » ferait un second chemin pour la même information, dont personne ne se servirait.

**Attention :** ce fichier a un `GamepadSource` public utilisé par `LockstepRoom.svelte` (`cycleGamepadSource`, ligne 1090) et `SoloRoom.svelte:406`. Les deux sont recâblés en Tasks 10 et 11. Cette tâche laisse donc le front cassé à la compilation entre les deux — c'est assumé et rattrapé avant le premier commit qui touche un `.svelte`.

- [ ] **Step 1: Écrire les tests qui échouent**

Dans `core/test/input.test.ts` : remplacer l'import et ajouter le harnais de contrôles, puis remplacer **toutes** les constructions `new InputCollector(KEY_CONFIG, …)`.

En tête de fichier :

```ts
import { InputCollector } from '../../frontend/src/lib/znet/input.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';
import { STANDARD_PAD } from '../../frontend/src/lib/controls/binding.js';

const KEY_CONFIG = {
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA',
	l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight'
};

/** Le joueur par défaut : ce clavier, et le mappage manette standard. */
const CONTROLS = { keys: KEY_CONFIG, pad: STANDARD_PAD };

/** Tout écouter, ce que fait un joueur seul. */
const ALL: { keyboard: boolean; pads: 'all' } = { keyboard: true, pads: 'all' };
```

Substitutions dans les tests existants :

| Avant | Après |
|---|---|
| `new InputCollector(KEY_CONFIG)` | `new InputCollector(CONTROLS)` |
| `new InputCollector(KEY_CONFIG, 'auto')` | `new InputCollector(CONTROLS, ALL)` |
| `new InputCollector(KEY_CONFIG, 'off')` | `new InputCollector(CONTROLS, { keyboard: true, pads: [] })` |
| `new InputCollector(KEY_CONFIG, 0)` | `new InputCollector(CONTROLS, { keyboard: true, pads: [0] })` |
| `new InputCollector(KEY_CONFIG, 1)` | `new InputCollector(CONTROLS, { keyboard: true, pads: [1] })` |
| `collector.setKeyConfig({ ...KEY_CONFIG, a: 'KeyM' })` | `collector.setControls({ ...CONTROLS, keys: { ...KEY_CONFIG, a: 'KeyM' } })` |

Le test `"'auto' merges every pad, which is what makes one controller drive two windows"` est **renommé et réécrit** : le comportement qu'il documentait est précisément celui qu'on corrige.

```ts
test("tout écouter reste le défaut d'un joueur seul", () => {
	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(CONTROLS, ALL);
		assert.equal(collector.read(), PAD.A, 'le bouton 1 est A dans le mappage standard');
	});
});
```

Le test `'the source can be changed at runtime and the pads enumerated'` devient :

```ts
test('les sources changent en cours de route', () => {
	withGamepads([{ index: 0, buttons: [1] }, { index: 2, buttons: [] }], () => {
		const collector = new InputCollector(CONTROLS, ALL);
		assert.equal(collector.read(), PAD.A);

		collector.setSources({ keyboard: true, pads: [] });
		assert.equal(collector.read(), 0);

		collector.setSources({ keyboard: true, pads: [2] });
		assert.equal(collector.read(), 0, 'le pad 2 n’a rien d’enfoncé');

		collector.setSources({ keyboard: true, pads: [0] });
		assert.equal(collector.read(), PAD.A);
	});
});
```

Étendre le harnais de faux pads pour porter des axes :

```ts
/** Installe de faux pads sur globalThis.navigator le temps de `fn`. */
function withGamepads<T>(
	pads: Array<{ index: number; buttons: number[]; axes?: number[] }>,
	fn: () => T
): T {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	const fake = {
		getGamepads: () =>
			pads.map((p) => ({
				index: p.index,
				id: `Fake pad ${p.index}`,
				connected: true,
				buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: p.buttons.includes(i) })),
				axes: p.axes ?? [0, 0]
			}))
	};
	Object.defineProperty(globalThis, 'navigator', { value: fake, configurable: true });
	try {
		return fn();
	} finally {
		if (previous) Object.defineProperty(globalThis, 'navigator', previous);
		else delete (globalThis as { navigator?: unknown }).navigator;
	}
}
```

Puis ajouter les nouveaux tests :

```ts
/* --------------------------------------------- la config manette est lue */

test('le mappage standard donne les mêmes bits que la table en dur qu’il remplace', () => {
	// Le test anti-régression du morceau : l'ancienne lecture était une table
	// codée en dur que la config ne pouvait pas influencer.
	const expected: Array<[number, number]> = [
		[0, PAD.B], [1, PAD.A], [2, PAD.Y], [3, PAD.X],
		[4, PAD.L], [5, PAD.R], [8, PAD.SELECT], [9, PAD.START],
		[12, PAD.UP], [13, PAD.DOWN], [14, PAD.LEFT], [15, PAD.RIGHT]
	];

	for (const [button, bit] of expected) {
		withGamepads([{ index: 0, buttons: [button] }], () => {
			const collector = new InputCollector(CONTROLS, ALL);
			assert.equal(collector.read(), bit, `le bouton ${button} doit donner ${bit}`);
		});
	}
});

test('le stick gauche fait toujours la croix', () => {
	// Il la faisait par une règle en dur. Il la fait maintenant par deux codes
	// PadAxis du mappage standard, et il doit la faire pareil.
	const cases: Array<[number[], number]> = [
		[[-1, 0], PAD.LEFT],
		[[1, 0], PAD.RIGHT],
		[[0, -1], PAD.UP],
		[[0, 1], PAD.DOWN],
		[[0.3, 0.3], 0]
	];

	for (const [axes, bit] of cases) {
		withGamepads([{ index: 0, buttons: [], axes }], () => {
			const collector = new InputCollector(CONTROLS, ALL);
			assert.equal(collector.read(), bit, `axes ${JSON.stringify(axes)}`);
		});
	}
});

test('une liaison manette réassignée prend effet', () => {
	withGamepads([{ index: 0, buttons: [7] }], () => {
		const collector = new InputCollector(
			{ keys: KEY_CONFIG, pad: { ...STANDARD_PAD, a: ['PadButton7'] } },
			ALL
		);
		assert.equal(collector.read(), PAD.A, 'le bouton 7 est devenu A');
	});

	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(
			{ keys: KEY_CONFIG, pad: { ...STANDARD_PAD, a: ['PadButton7'] } },
			ALL
		);
		assert.equal(collector.read(), 0, 'et le bouton 1 ne l’est plus');
	});
});

test('un emplacement manette vidé ne répond à rien', () => {
	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(
			{ keys: KEY_CONFIG, pad: { ...STANDARD_PAD, a: [] } },
			ALL
		);
		assert.equal(collector.read(), 0);
	});
});

test('un joueur sans clavier ignore les touches', () => {
	const win = fakeWindow();
	withoutGamepads(() => {
		const collector = new InputCollector(CONTROLS, { keyboard: false, pads: [] });
		collector.attach(win as never);

		win.fire('keydown', { code: 'KeyX' });
		assert.equal(collector.read(), 0, 'le clavier du J1 ne doit pas atteindre le J2');

		collector.detach(win as never);
	});
});

test('couper le clavier relâche ce qui était tenu', () => {
	const win = fakeWindow();
	withoutGamepads(() => {
		const collector = new InputCollector(CONTROLS, ALL);
		collector.attach(win as never);
		win.fire('keydown', { code: 'ArrowUp' });
		assert.equal(collector.read(), PAD.UP);

		collector.setSources({ keyboard: false, pads: 'all' });
		assert.equal(collector.read(), 0, 'sinon la direction reste bloquée pour toujours');

		collector.detach(win as never);
	});
});

test('deux joueurs sur deux pads ne se croisent pas', () => {
	withGamepads(
		[
			{ index: 0, buttons: [1] }, // A
			{ index: 1, buttons: [3] } // X
		],
		() => {
			const first = new InputCollector(CONTROLS, { keyboard: false, pads: [0] });
			const second = new InputCollector(CONTROLS, { keyboard: false, pads: [1] });

			assert.equal(first.read(), PAD.A);
			assert.equal(second.read(), PAD.X);
			assert.equal(first.read() & second.read(), 0, 'aucun recouvrement');
		}
	);
});

test('deux boutons enfoncés en même temps donnent leurs deux bits', () => {
	withGamepads([{ index: 0, buttons: [1, 9] }], () => {
		const collector = new InputCollector(CONTROLS, { keyboard: false, pads: [0] });
		assert.equal(collector.read(), PAD.A | PAD.START);
	});
});
```

- [ ] **Step 2: Lancer les tests pour vérifier qu'ils échouent**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/input.test.ts
```

Attendu : ÉCHEC — `setControls is not a function`, et le mappage manette ne réagit pas à la config.

- [ ] **Step 3: Réécrire `InputCollector`**

Remplacer tout le contenu de `frontend/src/lib/znet/input.ts` à partir de la déclaration `const BUTTONS` (les commentaires de tête du fichier restent) par :

```ts
import type { PlayerControls, InputSources, Button } from '$lib/controls/binding';
import { BUTTONS, parsePadCode } from '$lib/controls/binding';
import { PAD, type PadMask } from './protocol.js';

const BUTTON_BITS: Record<Button, number> = {
	a: PAD.A,
	b: PAD.B,
	x: PAD.X,
	y: PAD.Y,
	l: PAD.L,
	r: PAD.R,
	start: PAD.START,
	select: PAD.SELECT,
	up: PAD.UP,
	down: PAD.DOWN,
	left: PAD.LEFT,
	right: PAD.RIGHT
};

const AXIS_THRESHOLD = 0.5;

/** Tout écouter : le défaut d'un joueur seul, et rien d'autre. */
const EVERYTHING: InputSources = { keyboard: true, pads: 'all' };

export class InputCollector {
	private held = new Set<string>();
	/**
	 * Des paires plutôt qu'une Map : un code lié à deux boutons est un conflit
	 * que l'écran de config refuse de sauvegarder, mais une Map le perdrait en
	 * silence si jamais il arrivait quand même jusqu'ici.
	 */
	private keyBits: Array<[string, number]> = [];
	private padBits: Array<[string, number]> = [];
	private sources: InputSources = EVERYTHING;
	private attached = false;
	private onKeyDown = (e: KeyboardEvent) => this.handleKey(e, true);
	private onKeyUp = (e: KeyboardEvent) => this.handleKey(e, false);
	private onBlur = () => this.held.clear();

	constructor(controls: PlayerControls, sources: InputSources = EVERYTHING) {
		this.setControls(controls);
		this.sources = sources;
	}

	setControls(controls: PlayerControls): void {
		this.keyBits = [];
		this.padBits = [];
		for (const button of BUTTONS) {
			const bit = BUTTON_BITS[button];
			const key = controls.keys[button];
			if (key) this.keyBits.push([key, bit]);
			for (const code of controls.pad[button] ?? []) {
				if (code) this.padBits.push([code, bit]);
			}
		}
	}

	/**
	 * Change les périphériques que ce joueur écoute.
	 *
	 * Vide ce qui est tenu au clavier quand le clavier s'en va : sinon une
	 * direction enfoncée au moment du changement n'aurait plus jamais son
	 * keyup, et resterait bloquée pour la vie de la session.
	 */
	setSources(sources: InputSources): void {
		if (this.sources.keyboard && !sources.keyboard) this.held.clear();
		this.sources = sources;
	}

	getSources(): InputSources {
		return this.sources;
	}

	attach(target: Window = window): void {
		if (this.attached) return;
		target.addEventListener('keydown', this.onKeyDown);
		target.addEventListener('keyup', this.onKeyUp);
		// Perdre le focus une touche enfoncée la laisserait tenue pour
		// toujours, et en lockstep c'est un bouton bloqué sur les deux machines.
		target.addEventListener('blur', this.onBlur);
		this.attached = true;
	}

	detach(target: Window = window): void {
		if (!this.attached) return;
		target.removeEventListener('keydown', this.onKeyDown);
		target.removeEventListener('keyup', this.onKeyUp);
		target.removeEventListener('blur', this.onBlur);
		this.held.clear();
		this.attached = false;
	}

	/** Le masque à envoyer pour la prochaine frame. */
	read(): PadMask {
		let mask = 0;
		if (this.sources.keyboard) {
			for (const [code, bit] of this.keyBits) {
				if (this.held.has(code)) mask |= bit;
			}
		}
		return sanitise(mask | this.readPads());
	}

	private readPads(): number {
		const { pads } = this.sources;
		if (pads !== 'all' && pads.length === 0) return 0;
		if (typeof navigator === 'undefined' || !navigator.getGamepads) return 0;

		let mask = 0;
		for (const pad of navigator.getGamepads()) {
			if (!pad?.connected) continue;
			if (pads !== 'all' && !pads.includes(pad.index)) continue;
			for (const [code, bit] of this.padBits) {
				if (readPadCode(pad, code)) mask |= bit;
			}
		}
		return mask;
	}

	private handleKey(event: KeyboardEvent, down: boolean): void {
		if (!this.sources.keyboard) return;
		if (!this.keyBits.some(([code]) => code === event.code)) return;
		event.preventDefault();
		if (down) this.held.add(event.code);
		else this.held.delete(event.code);
	}
}

function readPadCode(pad: Gamepad, code: string): boolean {
	const described = parsePadCode(code);
	if (!described) return false;
	if (described.kind === 'button') return pad.buttons[described.index]?.pressed ?? false;
	const value = pad.axes[described.index] ?? 0;
	return described.dir === 'minus' ? value < -AXIS_THRESHOLD : value > AXIS_THRESHOLD;
}

/**
 * Une vraie manette ne peut pas rapporter deux directions opposées à la fois,
 * et certains jeux prennent des chemins réellement indéfinis quand ils en
 * voient. Laisser tomber la seconde garde les deux pairs sur le chemin défini.
 */
function sanitise(mask: number): number {
	if ((mask & (PAD.LEFT | PAD.RIGHT)) === (PAD.LEFT | PAD.RIGHT)) mask &= ~PAD.RIGHT;
	if ((mask & (PAD.UP | PAD.DOWN)) === (PAD.UP | PAD.DOWN)) mask &= ~PAD.DOWN;
	return mask & 0x0fff;
}
```

Dans `frontend/src/lib/znet/index.ts`, remplacer la ligne 52 `export type { GamepadSource } from './input.js';` par :

```ts
export {
	connectedPads,
	defaultAssignments,
	isPlayerActive,
	loadAssignments,
	padDisplayName,
	resolveSources,
	saveAssignments,
	DEVICES_STORAGE_KEY
} from './devices.js';
export type { Assignment, Assignments, GamepadRef, GamepadAssignment, PadInfo } from './devices.js';
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/input.test.ts
```

Attendu : tous les tests du fichier passent, anciens comme nouveaux.

- [ ] **Step 5: Vérifier que rien d'autre n'a bougé**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:all 2>&1 | tail -6
```

Attendu : `fail 0`. Le front ne compile pas encore (`SoloRoom` et `LockstepRoom` appellent l'ancienne API) : c'est attendu, et rattrapé en Tasks 10 et 11.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/znet/input.ts frontend/src/lib/znet/index.ts core/test/input.test.ts
git commit -m "Make the collector read the pad bindings it was given"
```

---

### Task 6: Le backend accepte les deux formes

**Files:**
- Modify: `backend/src/utils/key-config.ts`
- Modify: `backend/src/api/user.ts:15-65`
- Modify: `backend/src/services/user-config.ts`
- Modify: `backend/src/types/index.ts` (ajout des types)
- Test: `backend/test/controls-config.test.ts`
- Modify: `package.json` (le script `test:backend` prend déjà `backend/test/*.test.ts`, rien à ajouter)

**Interfaces:**
- Produces: `getDefaultControlsConfig(): ControlsConfig`, `normaliseControlsConfig(raw: unknown): ControlsConfig`, `isValidControlsConfig(raw: unknown): boolean`

**Duplication assumée.** Le backend ne peut pas importer `frontend/src/lib`, et le dépôt duplique déjà `KeyConfig` en trois endroits (`frontend/src/lib/types.ts`, `frontend/src/lib/config/keyConfig.ts`, `backend/src/types/index.ts`). La normalisation est donc réécrite ici, avec le même comportement, et les tests des deux côtés partagent les mêmes fixtures littérales — c'est ce qui les tient d'accord.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `backend/test/controls-config.test.ts` :

```ts
/**
 * Normalisation et validation de la config de contrôles, côté serveur.
 *
 * La colonne est un JSON opaque : ce module est la seule chose qui empêche une
 * config à moitié écrite d'atteindre un joueur. Il doit accepter la forme v1 -
 * un onglet resté ouvert sur l'ancien front sauvegarde encore comme ça - sans
 * jamais la rendre telle quelle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getDefaultControlsConfig,
	isValidControlsConfig,
	normaliseControlsConfig
} from '../src/utils/key-config.js';

const V1 = {
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA',
	l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight'
};

test('les défauts ont deux joueurs et deux tables chacun', () => {
	const config = getDefaultControlsConfig();
	assert.equal(config.version, 2);
	assert.equal(config.p1.keys.a, 'KeyX');
	assert.equal(config.p2.keys.a, 'KeyN');
	assert.deepEqual(config.p1.pad.up, ['PadButton12', 'PadAxis1Minus']);
	assert.deepEqual(config.p2.pad.a, ['PadButton1']);
});

test('une v1 est acceptée en écriture et normalisée en lecture', () => {
	assert.ok(isValidControlsConfig(V1), 'un onglet périmé doit pouvoir sauvegarder');

	const config = normaliseControlsConfig(V1);
	assert.equal(config.version, 2);
	assert.deepEqual(config.p1.keys, V1);
	assert.equal(config.p2.keys.up, 'KeyI');
});

test('une v2 est acceptée et traverse', () => {
	const v2 = normaliseControlsConfig(V1);
	assert.ok(isValidControlsConfig(v2));
	assert.deepEqual(normaliseControlsConfig(v2), v2, 'idempotente');
});

test('un code manette legacy migre côté manette', () => {
	const config = normaliseControlsConfig({ ...V1, a: 'Gamepad0Button2' });
	assert.deepEqual(config.p1.pad.a, ['PadButton2']);
	assert.equal(config.p1.keys.a, '');
});

test('la saleté est refusée en écriture', () => {
	for (const junk of [null, undefined, 42, 'nope', [], {}, { version: 2 }, { ...V1, a: 3 }]) {
		assert.ok(!isValidControlsConfig(junk), `${JSON.stringify(junk)} doit être refusé`);
	}
});

test('une v2 incomplète est refusée en écriture mais réparée en lecture', () => {
	const partial = { version: 2, p1: { keys: { a: 'KeyM' } } };
	assert.ok(!isValidControlsConfig(partial), 'on n’écrit pas une config à trous');
	assert.equal(normaliseControlsConfig(partial).p1.keys.up, 'ArrowUp', 'mais on sait la lire');
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test backend/test/controls-config.test.ts
```

Attendu : ÉCHEC, `getDefaultControlsConfig` n'existe pas.

- [ ] **Step 3: Écrire l'implémentation**

Ajouter à `backend/src/types/index.ts`, à côté de `KeyConfig` :

```ts
/** Une liste de codes manette par bouton SNES. Liste vide = non lié. */
export type PadConfig = Record<keyof KeyConfig, string[]>;

export interface PlayerControls {
  keys: KeyConfig;
  pad: PadConfig;
}

export interface ControlsConfig {
  version: 2;
  p1: PlayerControls;
  p2: PlayerControls;
}
```

Ajouter à `backend/src/utils/key-config.ts` (en gardant `getDefaultKeyConfig` et `isValidKeyConfig`, encore appelés ailleurs) :

```ts
import { ControlsConfig, KeyConfig, PadConfig, PlayerControls } from '../types/index.js';

const BUTTONS: (keyof KeyConfig)[] = [
  'up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'
];

/**
 * Les défauts du second joueur.
 *
 * Aucune intersection avec ceux du premier : deux joueurs au clavier sur la
 * même machine est le cas local le plus courant, et il doit marcher tel quel.
 * La copie de cette table côté front (`controls/binding.ts`) doit rester
 * identique - le dépôt duplique déjà `KeyConfig` pour la même raison, le
 * backend ne pouvant pas importer `frontend/src/lib`.
 */
function getDefaultP2KeyConfig(): KeyConfig {
  return {
    up: 'KeyI', down: 'KeyK', left: 'KeyJ', right: 'KeyL',
    a: 'KeyN', b: 'KeyB', x: 'KeyH', y: 'KeyG',
    l: 'KeyT', r: 'KeyY', start: 'KeyO', select: 'KeyU'
  };
}

/** La croix par les boutons 12-15 *et* par le stick, comme la lecture d'avant. */
function getStandardPadConfig(): PadConfig {
  return {
    up: ['PadButton12', 'PadAxis1Minus'],
    down: ['PadButton13', 'PadAxis1Plus'],
    left: ['PadButton14', 'PadAxis0Minus'],
    right: ['PadButton15', 'PadAxis0Plus'],
    a: ['PadButton1'], b: ['PadButton0'], x: ['PadButton3'], y: ['PadButton2'],
    l: ['PadButton4'], r: ['PadButton5'], start: ['PadButton9'], select: ['PadButton8']
  };
}

const PAD_CODE = /^(PadButton\d+|PadAxis\d+(Plus|Minus))$/;
const LEGACY_BUTTON = /^Gamepad\d+Button(\d+)$/;
const LEGACY_AXIS = /^Gamepad\d+Axis(\d+)(Plus|Minus)$/;

function legacyToPadCode(code: string): string | null {
  const button = LEGACY_BUTTON.exec(code);
  if (button) return `PadButton${button[1]}`;
  const axis = LEGACY_AXIS.exec(code);
  if (axis) return `PadAxis${axis[1]}${axis[2]}`;
  return null;
}

function defaultPlayer(keys: KeyConfig): PlayerControls {
  return { keys: { ...keys }, pad: getStandardPadConfig() };
}

export function getDefaultControlsConfig(): ControlsConfig {
  return {
    version: 2,
    p1: defaultPlayer(getDefaultKeyConfig()),
    p2: defaultPlayer(getDefaultP2KeyConfig())
  };
}

function normalisePlayer(raw: any, defaults: KeyConfig): PlayerControls {
  const player = defaultPlayer(defaults);
  const rawKeys = (raw && typeof raw.keys === 'object' && raw.keys) || {};
  const rawPad = (raw && typeof raw.pad === 'object' && raw.pad) || null;

  for (const button of BUTTONS) {
    if (rawPad) {
      const value = rawPad[button];
      if (Array.isArray(value)) {
        player.pad[button] = value.filter((code: unknown) => typeof code === 'string' && PAD_CODE.test(code));
      } else if (typeof value === 'string' && PAD_CODE.test(value)) {
        player.pad[button] = [value];
      }
    }

    const key = rawKeys[button];
    if (typeof key !== 'string') continue;
    const migrated = legacyToPadCode(key);
    if (migrated) {
      player.pad[button] = [migrated];
      player.keys[button] = '';
    } else {
      player.keys[button] = key;
    }
  }

  return player;
}

/**
 * Fait entrer n'importe quoi dans la forme v2.
 *
 * Appelée à chaque lecture, y compris sur sa propre sortie : elle doit être
 * idempotente, et le test l'exige.
 */
export function normaliseControlsConfig(raw: any): ControlsConfig {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.version === 2) {
      return {
        version: 2,
        p1: normalisePlayer(raw.p1, getDefaultKeyConfig()),
        p2: normalisePlayer(raw.p2, getDefaultP2KeyConfig())
      };
    }
    if (isValidKeyConfig(raw)) {
      return {
        version: 2,
        p1: normalisePlayer({ keys: raw }, getDefaultKeyConfig()),
        p2: defaultPlayer(getDefaultP2KeyConfig())
      };
    }
  }
  return getDefaultControlsConfig();
}

function isCompletePlayer(raw: any): boolean {
  if (!raw || typeof raw !== 'object') return false;
  if (!raw.keys || typeof raw.keys !== 'object') return false;
  if (!raw.pad || typeof raw.pad !== 'object') return false;
  return BUTTONS.every(
    (button) =>
      typeof raw.keys[button] === 'string' &&
      Array.isArray(raw.pad[button]) &&
      raw.pad[button].every((code: unknown) => typeof code === 'string')
  );
}

/**
 * Ce qu'on accepte d'écrire dans la base.
 *
 * Les deux formes, parce qu'un onglet resté ouvert sur l'ancien front
 * sauvegarde encore une `KeyConfig` nue, et qu'un 400 lui serait
 * incompréhensible. Rien d'incomplet, en revanche : une config à trous
 * produirait un bouton qui ne répond pas, et rien en aval ne le rattraperait.
 */
export function isValidControlsConfig(raw: any): boolean {
  if (isValidKeyConfig(raw)) return true;
  if (!raw || typeof raw !== 'object' || raw.version !== 2) return false;
  return isCompletePlayer(raw.p1) && isCompletePlayer(raw.p2);
}
```

Dans `backend/src/api/user.ts` : remplacer `getDefaultKeyConfig` par `getDefaultControlsConfig`, `isValidKeyConfig` par `isValidControlsConfig`, et normaliser en lecture.

```ts
import {
  getDefaultControlsConfig,
  isValidControlsConfig,
  normaliseControlsConfig
} from '../utils/key-config.js';

// GET /controls
userRouter.get('/controls', requireAuth, asyncHandler(async (req, res) => {
  try {
    const userId = (req.user as any).id;
    const stored = findControlsConfig(getDb(), userId);
    if (!stored) return res.json(getDefaultControlsConfig());
    // Normalisé ici plutôt que dans le front : la base contient encore des
    // configs à un joueur, et un seul endroit doit savoir les lire.
    res.json(normaliseControlsConfig(JSON.parse(stored)));
  } catch (error) {
    logger.error({ err: error }, 'Error fetching controls config');
    res.status(500).json({ error: 'Failed to fetch controls configuration' });
  }
}));

// PUT /controls
userRouter.put('/controls', requireAuth, asyncHandler(async (req, res) => {
  try {
    const userId = (req.user as any).id;
    if (!isValidControlsConfig(req.body)) {
      return res.status(400).json({ error: 'Invalid controls configuration' });
    }
    const config = normaliseControlsConfig(req.body);
    updateControlsConfig(getDb(), userId, JSON.stringify(config));
    res.json({ message: 'Controls configuration updated successfully', config });
  } catch (error) {
    logger.error({ err: error }, 'Error updating controls config');
    res.status(500).json({ error: 'Failed to update controls configuration' });
  }
}));

// POST /controls/reset — rend les deux joueurs et les deux tables
userRouter.post('/controls/reset', requireAuth, asyncHandler(async (req, res) => {
  try {
    const userId = (req.user as any).id;
    const defaultConfig = getDefaultControlsConfig();
    updateControlsConfig(getDb(), userId, JSON.stringify(defaultConfig));
    res.json({ message: 'Controls reset to defaults', config: defaultConfig });
  } catch (error) {
    logger.error({ err: error }, 'Error resetting controls config');
    res.status(500).json({ error: 'Failed to reset controls configuration' });
  }
}));
```

Dans `backend/src/services/user-config.ts` : `getUserKeyConfig` sert le salon, qui ne véhicule **qu'une** `KeyConfig` — celle du J1. Elle continue donc de rendre une `KeyConfig`, extraite de la config normalisée.

```ts
import { getDefaultControlsConfig, normaliseControlsConfig } from '../utils/key-config.js';

/**
 * La `KeyConfig` du joueur 1, pour le salon.
 *
 * Le protocole de salle ne transporte qu'un mappage par membre - un pair
 * distant occupe le port 2, pas un second joueur local - donc c'est bien le
 * J1 qu'il faut, et pas la config entière.
 */
export async function getUserKeyConfig(userId: string): Promise<KeyConfig> {
  const cacheKey = `keyconfig:${userId}`;
  const cached = cache.get<KeyConfig>(cacheKey);
  if (cached) return cached;

  let config = getDefaultControlsConfig();
  try {
    const stored = findControlsConfig(getDb(), userId);
    if (stored) config = normaliseControlsConfig(JSON.parse(stored));
  } catch (error) {
    logger.error({ err: error, userId }, 'Error loading user controls config');
  }

  cache.set(cacheKey, config.p1.keys, 300000);
  return config.p1.keys;
}
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test backend/test/controls-config.test.ts && npm run test:backend 2>&1 | tail -5
```

Attendu : les 6 tests passent, et la suite backend reste à `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/key-config.ts backend/src/api/user.ts backend/src/services/user-config.ts backend/src/types/index.ts backend/test/controls-config.test.ts
git commit -m "Teach the server a controls config with two players in it"
```

---

### Task 7: `SnesPad.svelte`, le dessin

**Files:**
- Create: `frontend/src/lib/components/SnesPad.svelte`
- Create (jetable, supprimé en fin de tâche) : `frontend/src/routes/dev-snespad/+page.svelte`

**Interfaces:**
- Consumes: `Button`, `BUTTONS`, `shortLabelList` (Tasks 1–2)
- Produces: composant à props `bindings: Record<Button, string[]>`, `capturing: Button | null`, `pressed: Set<Button>`, `conflicts: Set<Button>`, `labels: Record<Button, string>`, `interactive = true` ; événement `select` avec `{ button: Button }`

Aucun harnais de test de composant dans ce dépôt : la vérification est une capture d'écran.

- [ ] **Step 1: Écrire le composant**

Créer `frontend/src/lib/components/SnesPad.svelte` :

```svelte
<script lang="ts">
  /**
   * Une manette SNES sur laquelle on clique pour réassigner.
   *
   * Sans état et sans logique : elle reçoit douze listes de codes et rend
   * douze libellés. Ce qui se passe quand on clique appartient à
   * PlayerControls, ce que veut dire un code appartient à binding.ts.
   *
   * La liaison est écrite *sur* le bouton plutôt qu'à côté dans une liste,
   * parce que le dessin doit être la config et pas sa légende. Le prix est un
   * libellé de trois caractères au plus, d'où les formes courtes ; la forme
   * longue est dans l'aria-label, qui est aussi ce que lit un lecteur d'écran.
   */
  import { createEventDispatcher } from 'svelte';
  import { BUTTONS, shortLabelList, type Button } from '$lib/controls/binding';

  export let bindings: Record<Button, string[]>;
  export let capturing: Button | null = null;
  export let pressed: Set<Button> = new Set();
  export let conflicts: Set<Button> = new Set();
  /** Le nom lisible de chaque bouton, déjà traduit, pour les aria-labels. */
  export let labels: Record<Button, string>;
  /** Les descriptions longues des liaisons, déjà traduites. */
  export let descriptions: Record<Button, string>;
  export let interactive = true;

  const dispatch = createEventDispatcher<{ select: { button: Button } }>();

  /**
   * Géométrie, dans un viewBox de 520 x 244.
   *
   * Les libellés sont à 18 unités, soit 3,5 % de la largeur : environ 10 px
   * dans les 280 px utiles du panneau de pause, ce qui reste lisible en gras
   * monospace pour une ou deux lettres.
   */
  const FACE = { x: 400, y: 78, r: 24 } as const;

  function choose(button: Button) {
    if (!interactive) return;
    dispatch('select', { button });
  }

  /**
   * Entrée et Espace activent un bouton du dessin - sauf pendant une capture,
   * où la touche appartient au joueur qui est en train de lier `⏎` à Start.
   */
  function onKey(event: KeyboardEvent, button: Button) {
    if (capturing !== null) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    choose(button);
  }

  $: label = (button: Button) =>
    `${labels[button]} — ${descriptions[button]}`;
</script>

<svg viewBox="0 0 520 244" class="pad" role="group" aria-label="Manette SNES">
  <defs>
    <linearGradient id="snes-body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e6e6ee" />
      <stop offset="1" stop-color="#a5a5b6" />
    </linearGradient>
    <linearGradient id="snes-shoulder" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d4d4de" />
      <stop offset="1" stop-color="#9a9aa9" />
    </linearGradient>
  </defs>

  <!-- gâchettes -->
  {#each [{ b: 'l', x: 74, letter: 'L' }, { b: 'r', x: 338, letter: 'R' }] as shoulder}
    <g
      class="hit"
      class:capturing={capturing === shoulder.b}
      class:pressed={pressed.has(shoulder.b)}
      class:conflict={conflicts.has(shoulder.b)}
      role="button"
      tabindex={interactive ? 0 : -1}
      aria-label={label(shoulder.b)}
      on:click={() => choose(shoulder.b)}
      on:keydown={(e) => onKey(e, shoulder.b)}
    >
      <rect x={shoulder.x} y="6" width="108" height="30" rx="12" fill="url(#snes-shoulder)" stroke="#7b7b8a" stroke-width="1.6" />
      <text x={shoulder.x + 22} y="27" class="glyph">{shoulder.letter}</text>
      <text x={shoulder.x + 72} y="27" class="binding dark">{shortLabelList(bindings[shoulder.b])}</text>
    </g>
  {/each}

  <rect x="14" y="32" width="492" height="180" rx="88" fill="url(#snes-body)" stroke="#7b7b8a" stroke-width="2" />

  <!-- croix directionnelle -->
  <g fill="#41414c" stroke="#2a2a33" stroke-width="1.6">
    <rect x="112" y="74" width="38" height="100" rx="6" />
    <rect x="81" y="105" width="100" height="38" rx="6" />
  </g>
  {#each [
    { b: 'up', x: 131, y: 96, hit: { x: 112, y: 74, w: 38, h: 31 } },
    { b: 'down', x: 131, y: 168, hit: { x: 112, y: 143, w: 38, h: 31 } },
    { b: 'left', x: 100, y: 131, hit: { x: 81, y: 105, w: 31, h: 38 } },
    { b: 'right', x: 162, y: 131, hit: { x: 150, y: 105, w: 31, h: 38 } }
  ] as dir}
    <g
      class="hit"
      class:capturing={capturing === dir.b}
      class:pressed={pressed.has(dir.b)}
      class:conflict={conflicts.has(dir.b)}
      role="button"
      tabindex={interactive ? 0 : -1}
      aria-label={label(dir.b)}
      on:click={() => choose(dir.b)}
      on:keydown={(e) => onKey(e, dir.b)}
    >
      <rect x={dir.hit.x} y={dir.hit.y} width={dir.hit.w} height={dir.hit.h} fill="transparent" />
      <text x={dir.x} y={dir.y} class="binding light">{shortLabelList(bindings[dir.b])}</text>
    </g>
  {/each}

  <!-- boutons de face : X en haut, Y à gauche, A à droite, B en bas -->
  {#each [
    { b: 'x', cx: 400, cy: 78, fill: '#2f6bd8', stroke: '#1d4795', letter: 'X' },
    { b: 'y', cx: 356, cy: 122, fill: '#2fa34a', stroke: '#1d6e33', letter: 'Y' },
    { b: 'a', cx: 444, cy: 122, fill: '#d63a3a', stroke: '#95251f', letter: 'A' },
    { b: 'b', cx: 400, cy: 166, fill: '#e0b325', stroke: '#9c7a14', letter: 'B' }
  ] as face}
    <g
      class="hit"
      class:capturing={capturing === face.b}
      class:pressed={pressed.has(face.b)}
      class:conflict={conflicts.has(face.b)}
      role="button"
      tabindex={interactive ? 0 : -1}
      aria-label={label(face.b)}
      on:click={() => choose(face.b)}
      on:keydown={(e) => onKey(e, face.b)}
    >
      <circle cx={face.cx} cy={face.cy} r={FACE.r} fill={face.fill} stroke={face.stroke} stroke-width="1.6" />
      <text x={face.cx} y={face.cy - 4} class="glyph on-colour">{face.letter}</text>
      <text x={face.cx} y={face.cy + 13} class="binding light">{shortLabelList(bindings[face.b])}</text>
    </g>
  {/each}

  <!-- select et start -->
  {#each [
    { b: 'select', x: 198, tx: 224, label: 'SELECT', lx: 206 },
    { b: 'start', x: 258, tx: 284, label: 'START', lx: 300 }
  ] as pill}
    <g
      class="hit"
      class:capturing={capturing === pill.b}
      class:pressed={pressed.has(pill.b)}
      class:conflict={conflicts.has(pill.b)}
      role="button"
      tabindex={interactive ? 0 : -1}
      aria-label={label(pill.b)}
      on:click={() => choose(pill.b)}
      on:keydown={(e) => onKey(e, pill.b)}
    >
      <g transform="rotate(-18 252 160)">
        <rect x={pill.x} y="150" width="52" height="19" rx="9.5" fill="#6b6b78" stroke="#494954" stroke-width="1.3" />
        <text x={pill.tx} y="164" class="binding light small">{shortLabelList(bindings[pill.b])}</text>
      </g>
      <text x={pill.lx} y="196" class="glyph faint">{pill.label}</text>
    </g>
  {/each}
</svg>

<style>
  .pad {
    width: 100%;
    height: auto;
    display: block;
  }

  .hit {
    cursor: pointer;
  }

  .hit:focus-visible {
    outline: 2px solid #7ea6ff;
    outline-offset: 2px;
  }

  text {
    text-anchor: middle;
    pointer-events: none;
    user-select: none;
  }

  /* 18 unités dans un viewBox de 520 : ~3,5 % de la largeur, donc ~10 px dans
     les 280 px utiles du panneau de pause. En dessous ce n'est plus lisible. */
  .binding {
    font-family: 'Monaco', 'Courier New', monospace;
    font-size: 18px;
    font-weight: 700;
  }

  .binding.small {
    font-size: 14px;
  }

  .light {
    fill: #fff;
  }

  .dark {
    fill: #33333d;
  }

  .glyph {
    font-family: system-ui, sans-serif;
    font-size: 14px;
    font-weight: 700;
    fill: #3a3a46;
  }

  .glyph.on-colour {
    fill: #fff;
    font-size: 11px;
    opacity: 0.9;
  }

  .glyph.faint {
    font-size: 10px;
    fill: #5c5c68;
  }

  /* En capture : la cible clignote, comme le faisait le bouton de l'ancienne
     grille - c'est le même signal, au même endroit que l'attention. */
  .hit.capturing rect,
  .hit.capturing circle {
    stroke: #1976d2;
    stroke-width: 3;
    animation: pulse 1s ease-in-out infinite;
  }

  /* Enfoncé en direct : c'est ce qui dit au joueur quelle manette il tient. */
  .hit.pressed circle,
  .hit.pressed rect {
    filter: brightness(1.5);
  }

  .hit.conflict circle,
  .hit.conflict rect {
    stroke: #d32f2f;
    stroke-width: 3;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
</style>
```

- [ ] **Step 2: Monter une route jetable pour le voir**

Créer `frontend/src/routes/dev-snespad/+page.svelte` :

```svelte
<script lang="ts">
  import SnesPad from '$lib/components/SnesPad.svelte';
  import { BUTTONS, DEFAULT_P1_KEYS, STANDARD_PAD, type Button } from '$lib/controls/binding';

  const keyBindings = Object.fromEntries(
    BUTTONS.map((b) => [b, [DEFAULT_P1_KEYS[b]]])
  ) as Record<Button, string[]>;
  const labels = Object.fromEntries(BUTTONS.map((b) => [b, b])) as Record<Button, string>;
  const descriptions = Object.fromEntries(BUTTONS.map((b) => [b, 'test'])) as Record<Button, string>;
</script>

<div style="background:#1b1b1b;padding:2rem;display:grid;gap:2rem;grid-template-columns:1fr 1fr">
  <div>
    <p style="color:#aaa">Clavier, avec A en capture et B en conflit</p>
    <SnesPad bindings={keyBindings} {labels} {descriptions} capturing="a" conflicts={new Set(['b'])} />
  </div>
  <div>
    <p style="color:#aaa">Manette standard, X enfoncé</p>
    <SnesPad bindings={STANDARD_PAD} {labels} {descriptions} pressed={new Set(['x'])} />
  </div>
  <div style="width:280px">
    <p style="color:#aaa">À la largeur du panneau de pause</p>
    <SnesPad bindings={keyBindings} {labels} {descriptions} />
  </div>
</div>
```

- [ ] **Step 3: Capturer et regarder**

Lancer le front (voir la recette de la Task 12 pour les cinq obstacles du worktree), puis :

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node -e "
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  await p.goto('http://localhost:5273/dev-snespad', { waitUntil: 'networkidle' });
  await p.screenshot({ path: '/tmp/snespad.png', fullPage: true });
  await b.close();
})();
"
```

Vérifier sur la capture : aucun libellé ne chevauche un autre ; les quatre lettres A/B/X/Y sont lisibles sur leur bouton ; la liaison de `L` et `R` ne sort pas de la gâchette ; à 280 px les libellés restent lisibles ; le bouton en capture clignote et celui en conflit est cerclé de rouge.

- [ ] **Step 4: Supprimer la route jetable**

```bash
rm -rf frontend/src/routes/dev-snespad
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/SnesPad.svelte
git commit -m "Draw the pad, and put each binding on its own button"
```

---

### Task 8: `PlayerControls.svelte`, la colonne d'un joueur

**Files:**
- Create: `frontend/src/lib/components/PlayerControls.svelte`
- Modify: `frontend/src/lib/i18n/translations.ts`

**Interfaces:**
- Consumes: `SnesPad` (Task 7), `binding.ts` (Tasks 1–3), `devices.ts` (Task 4), `CaptureGate` (`frontend/src/lib/controls/capture-gate.ts`, inchangée)
- Produces: composant à props `player: 1 | 2`, `controls: PlayerControls`, `assignment: Assignment`, `sources: InputSources`, `pads: PadInfo[]`, `conflicts: { keys: ConflictMap; pad: ConflictMap }`, `allowAuto: boolean`, `busy: boolean` ; événements `change` (`{ controls }`), `assign` (`{ assignment }`), `capturing` (`{ active: boolean }`)

**`sources` est une prop, pas un calcul local.** Le composant ne voit que sa propre assignation, donc il ne peut pas savoir quel pad l'autre joueur a réclamé — et une résolution partielle recalculée ici ferait réagir le J1 à la manette du J2 dès que celui-ci en reçoit une, c'est-à-dire exactement le bug que ce morceau existe pour supprimer. La coquille possède les deux assignations : c'est elle qui appelle `resolveSources` et qui descend le résultat. Seule la détection échappe à la règle et écoute tous les pads, puisque le pad qu'on cherche n'est justement pas encore assigné.

- [ ] **Step 1: Ajouter les clés i18n**

Dans `frontend/src/lib/i18n/translations.ts`, section `en` :

```ts
    // Two-player controls
    inputSources: 'Sources',
    keyboardSource: 'Keyboard',
    noController: 'No controller',
    allFreeControllers: 'All free controllers',
    detectController: 'Detect',
    pressButtonOnController: 'Press a button on player {player}\'s controller',
    editingKeyboard: 'Keyboard',
    editingController: 'Controller',
    standardMapping: 'Reset to standard mapping',
    boundToKey: 'bound to {key}',
    boundToPadButton: 'bound to controller button {index}',
    boundToPadAxis: 'bound to controller axis {index} {dir}',
    unboundBinding: 'not bound',
    alsoUsedByPlayer: 'Also used by player {player} ({button})',
    playerInactive: 'This player has no device yet, so port 2 stays silent.',
    detectCancelled: 'No controller answered.',
```

Section `fr`, aux mêmes clés :

```ts
    // Contrôles à deux joueurs
    inputSources: 'Sources',
    keyboardSource: 'Clavier',
    noController: 'Aucune manette',
    allFreeControllers: 'Toutes les manettes libres',
    detectController: 'Détecter',
    pressButtonOnController: 'Appuie sur un bouton de la manette du joueur {player}',
    editingKeyboard: 'Clavier',
    editingController: 'Manette',
    standardMapping: 'Repartir du mappage standard',
    boundToKey: 'lié à {key}',
    boundToPadButton: 'lié au bouton {index} de la manette',
    boundToPadAxis: 'lié à l\'axe {index} {dir} de la manette',
    unboundBinding: 'non lié',
    alsoUsedByPlayer: 'Aussi utilisé par le joueur {player} ({button})',
    playerInactive: 'Ce joueur n\'a pas encore de périphérique : le port 2 reste muet.',
    detectCancelled: 'Aucune manette n\'a répondu.',
```

- [ ] **Step 2: Écrire le composant**

Créer `frontend/src/lib/components/PlayerControls.svelte` :

```svelte
<script lang="ts">
  /**
   * Un joueur : ses sources, la table qu'il édite, son dessin.
   *
   * Deux questions distinctes vivent ici, et les mélanger serait l'erreur :
   * « quel périphérique tient ce joueur » (l'assignation, qui décide aussi
   * s'il joue) et « quelle table je suis en train de modifier » (clavier ou
   * manette, deux tables indépendantes et toutes deux actives).
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import { CaptureGate } from '$lib/controls/capture-gate';
  import SnesPad from './SnesPad.svelte';
  import {
    BUTTONS,
    STANDARD_PAD,
    describeCode,
    isPadCode,
    shortLabel,
    type Button,
    type ConflictMap,
    type PlayerControls as PlayerControlsConfig
  } from '$lib/controls/binding';
  import { connectedPads, padDisplayName, type Assignment, type PadInfo } from '$lib/znet/devices';

  export let player: 1 | 2;
  export let controls: PlayerControlsConfig;
  export let assignment: Assignment;
  export let pads: PadInfo[] = [];
  export let conflicts: { keys: ConflictMap; pad: ConflictMap };
  /** `'auto'` n'est offert qu'au J1 : pour un second joueur c'est un piège. */
  export let allowAuto = false;
  export let busy = false;

  const dispatch = createEventDispatcher<{
    change: { controls: PlayerControlsConfig };
    assign: { assignment: Assignment };
    capturing: { active: boolean };
  }>();

  /** Laquelle des deux tables le dessin montre et capture. */
  let editing: 'keys' | 'pad' = 'keys';
  let capturing: Button | null = null;
  let sequence = -1;
  let controlsBeforeSequence: PlayerControlsConfig | null = null;
  let detecting = false;
  let notice = '';
  let pollTimer: number | null = null;
  const gate = new CaptureGate();

  /** L'ordre d'un pouce qui fait le tour du pad, comme dans l'ancienne grille. */
  const BIND_ORDER: Button[] = [
    'up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'
  ];

  $: buttonLabels = {
    up: t($language, 'dPadUp'), down: t($language, 'dPadDown'),
    left: t($language, 'dPadLeft'), right: t($language, 'dPadRight'),
    a: t($language, 'aButton'), b: t($language, 'bButton'),
    x: t($language, 'xButton'), y: t($language, 'yButton'),
    l: t($language, 'lShoulder'), r: t($language, 'rShoulder'),
    start: t($language, 'startButton'), select: t($language, 'selectButton')
  } as Record<Button, string>;

  $: hasPad = assignment.gamepad !== null;
  // Un joueur sans manette n'a rien à éditer côté manette. Le sélecteur
  // reviendrait sur une table que personne ne lit.
  $: if (!hasPad && editing === 'pad') editing = 'keys';

  $: bindings = Object.fromEntries(
    BUTTONS.map((button) => [
      button,
      editing === 'keys' ? [controls.keys[button]].filter(Boolean) : controls.pad[button]
    ])
  ) as Record<Button, string[]>;

  $: activeConflicts = new Set(conflicts[editing].keys());

  /** La forme longue d'une liaison, pour l'aria-label du dessin. */
  function describe(button: Button): string {
    const codes = editing === 'keys' ? [controls.keys[button]] : controls.pad[button];
    const first = codes.find(Boolean);
    if (!first) return t($language, 'unboundBinding');
    const described = describeCode(first);
    if (described.kind === 'keyboard') {
      return t($language, 'boundToKey', { key: shortLabel(described.code) });
    }
    if (described.kind === 'padButton') {
      return t($language, 'boundToPadButton', { index: described.index });
    }
    if (described.kind === 'padAxis') {
      return t($language, 'boundToPadAxis', {
        index: described.index,
        dir: described.dir === 'minus' ? '−' : '+'
      });
    }
    return t($language, 'unboundBinding');
  }

  $: descriptions = Object.fromEntries(
    BUTTONS.map((button) => [button, describe(button)])
  ) as Record<Button, string>;

  /* ------------------------------------------------------------- capture */

  function startCapture(button: Button) {
    capturing = button;
    notice = '';
    gate.reset();
    startPolling();
    dispatch('capturing', { active: true });
  }

  function stopCapture() {
    capturing = null;
    sequence = -1;
    controlsBeforeSequence = null;
    dispatch('capturing', { active: false });
  }

  function startSequence() {
    controlsBeforeSequence = { keys: { ...controls.keys }, pad: { ...controls.pad } };
    sequence = 0;
    startCapture(BIND_ORDER[0]);
  }

  function advance() {
    sequence += 1;
    if (sequence >= BIND_ORDER.length) stopCapture();
    else capturing = BIND_ORDER[sequence];
  }

  /**
   * Abandonner remet ce qui était là avant.
   *
   * Garder les liaisons faites jusque-là laisserait le pad à moitié réécrit
   * dans un état que le joueur n'a pas choisi et dont il ne voit pas la forme.
   */
  function cancelSequence() {
    if (controlsBeforeSequence) controls = controlsBeforeSequence;
    dispatch('change', { controls });
    stopCapture();
  }

  /** Écrit une liaison, et avance s'il y a où avancer. */
  function apply(code: string) {
    if (!capturing) return;
    const next = { keys: { ...controls.keys }, pad: { ...controls.pad } };
    // Une capture remplace : c'est le comportement prévisible, et les seules
    // listes à plusieurs codes sont celles du mappage standard.
    if (isPadCode(code)) next.pad[capturing] = [code];
    else next.keys[capturing] = code;
    controls = next;
    dispatch('change', { controls });

    if (sequence >= 0) advance();
    else stopCapture();
  }

  /**
   * Ce qui est tenu au clavier, pour allumer le dessin hors capture.
   *
   * Même service que le sondage des manettes, et pour la même raison : le
   * joueur appuie, il voit son bouton s'allumer, il sait que sa liaison marche.
   */
  let heldKeys = new Set<string>();

  function trackKey(code: string, down: boolean) {
    const next = new Set(heldKeys);
    if (down) next.add(code);
    else next.delete(code);
    heldKeys = next;
  }

  function handleKeyup(event: KeyboardEvent) {
    trackKey(event.code, false);
  }

  function handleBlur() {
    heldKeys = new Set();
  }

  function handleKeydown(event: KeyboardEvent) {
    // Avant tout retour anticipé, et sans preventDefault : suivre les touches
    // ne doit rien empêcher quand aucune capture n'est en cours.
    trackKey(event.code, true);

    if (detecting && event.code === 'Escape') {
      stopDetecting(t($language, 'detectCancelled'));
      return;
    }
    if (!capturing) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.code === 'Escape') {
      if (sequence >= 0) cancelSequence();
      else stopCapture();
      return;
    }
    // Laisse ce bouton tel quel et passe au suivant : sans ça, un joueur qui
    // ne veut rien sur L et R doit inventer une liaison ou jeter la série.
    if (sequence >= 0 && event.code === 'Tab') {
      advance();
      return;
    }
    // Le clavier ne peut écrire que dans la table clavier.
    if (editing !== 'keys') return;

    const code = gate.keydown(event);
    if (code) apply(code);
  }

  /* -------------------------------------------------- sondage des manettes */

  /**
   * Sonde les manettes de ce joueur, pour trois usages : capturer une liaison,
   * détecter quelle manette lui appartient, et allumer le dessin en direct -
   * ce dernier étant ce qui lui dit qu'il tient la bonne.
   */
  let pressedCodes: string[] = [];

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(poll, 50);
  }

  function stopPolling() {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
    pressedCodes = [];
  }

  function myPadIndices(): number[] | 'all' {
    if (detecting) return 'all';
    const { gamepad } = assignment;
    if (gamepad === null) return [];
    if (gamepad === 'auto') return 'all';
    const found = pads.find((pad) => pad.id === gamepad.id) ?? pads.find((p) => p.index === gamepad.index);
    return found ? [found.index] : [];
  }

  function poll() {
    const mine = myPadIndices();
    const active: string[] = [];
    let source: number | null = null;

    for (const pad of connectedPads()) {
      if (mine !== 'all' && !mine.includes(pad.index)) continue;
      const live = navigator.getGamepads()[pad.index];
      if (!live) continue;
      for (let i = 0; i < live.buttons.length; i++) {
        if (live.buttons[i]?.pressed) {
          active.push(`PadButton${i}`);
          source ??= pad.index;
        }
      }
      for (let i = 0; i < live.axes.length; i++) {
        const value = live.axes[i];
        if (Math.abs(value) > 0.5) {
          active.push(`PadAxis${i}${value > 0 ? 'Plus' : 'Minus'}`);
          source ??= pad.index;
        }
      }
    }

    pressedCodes = active;

    if (detecting) {
      if (source === null) return;
      const pad = pads.find((p) => p.index === source);
      if (pad) {
        assignment = { ...assignment, gamepad: { id: pad.id, index: pad.index } };
        dispatch('assign', { assignment });
      }
      stopDetecting('');
      return;
    }

    if (!capturing || editing !== 'pad') return;
    const captured = gate.tick(active);
    if (captured) apply(captured);
  }

  /** Les boutons SNES allumés à l'instant, dans la table affichée. */
  $: pressed = new Set(
    BUTTONS.filter((button) =>
      editing === 'pad'
        ? controls.pad[button].some((code) => pressedCodes.includes(code))
        : heldKeys.has(controls.keys[button])
    )
  );

  /* ------------------------------------------------------------ détection */

  function startDetecting() {
    detecting = true;
    notice = t($language, 'pressButtonOnController', { player });
    gate.reset();
    startPolling();
  }

  function stopDetecting(message: string) {
    detecting = false;
    notice = message;
    if (!capturing) stopPolling();
  }

  /* -------------------------------------------------------- assignation */

  function setKeyboard(on: boolean) {
    assignment = { ...assignment, keyboard: on };
    dispatch('assign', { assignment });
  }

  function setGamepad(value: string) {
    const gamepad =
      value === 'none' ? null : value === 'auto' ? 'auto' : padFromValue(value);
    assignment = { ...assignment, gamepad };
    dispatch('assign', { assignment });
  }

  function padFromValue(value: string) {
    const index = Number(value);
    const pad = pads.find((p) => p.index === index);
    return pad ? { id: pad.id, index: pad.index } : null;
  }

  $: gamepadValue =
    assignment.gamepad === null
      ? 'none'
      : assignment.gamepad === 'auto'
        ? 'auto'
        : String(assignment.gamepad.index);

  function resetPadToStandard() {
    controls = { keys: { ...controls.keys }, pad: { ...STANDARD_PAD } };
    dispatch('change', { controls });
  }

  // Le panneau peut être fermé en pleine capture - le menu pause est à un clic
  // - et le sondage tournerait sinon pour la vie de la page.
  onDestroy(stopPolling);

  // Le dessin doit s'allumer même hors capture : c'est ce qui permet de
  // vérifier qu'on tient la bonne manette.
  $: if (editing === 'pad' && hasPad) startPolling();
  $: if (editing !== 'pad' && !capturing && !detecting) stopPolling();
</script>

<svelte:window on:keydown={handleKeydown} on:keyup={handleKeyup} on:blur={handleBlur} />

<section class="player">
  <header>
    <h4>{t($language, player === 1 ? 'player1' : 'player2')}</h4>

    <div class="sources">
      <label>
        <input
          type="checkbox"
          checked={assignment.keyboard}
          disabled={busy}
          on:change={(e) => setKeyboard(e.currentTarget.checked)}
        />
        {t($language, 'keyboardSource')}
      </label>

      <select value={gamepadValue} disabled={busy} on:change={(e) => setGamepad(e.currentTarget.value)}>
        <option value="none">{t($language, 'noController')}</option>
        {#if allowAuto}
          <option value="auto">{t($language, 'allFreeControllers')}</option>
        {/if}
        {#each pads as pad}
          <option value={String(pad.index)}>{padDisplayName(pad.id) || `#${pad.index + 1}`}</option>
        {/each}
      </select>

      <button type="button" disabled={busy || detecting} on:click={startDetecting}>
        {t($language, 'detectController')}
      </button>
    </div>
  </header>

  <div class="tables" role="group">
    <button type="button" class:on={editing === 'keys'} on:click={() => (editing = 'keys')}>
      {t($language, 'editingKeyboard')}
    </button>
    {#if hasPad}
      <button type="button" class:on={editing === 'pad'} on:click={() => (editing = 'pad')}>
        {t($language, 'editingController')}
      </button>
    {/if}
  </div>

  <SnesPad
    {bindings}
    {capturing}
    {pressed}
    conflicts={activeConflicts}
    labels={buttonLabels}
    {descriptions}
    interactive={!busy}
    on:select={(e) => startCapture(e.detail.button)}
  />

  <div class="actions">
    <button type="button" disabled={busy || capturing !== null} on:click={startSequence}>
      🎮 {t($language, 'configureAllButtons')}
    </button>
    {#if editing === 'pad'}
      <button type="button" disabled={busy || capturing !== null} on:click={resetPadToStandard}>
        {t($language, 'standardMapping')}
      </button>
    {/if}
  </div>

  {#if capturing}
    <p class="hint">
      {#if sequence >= 0}
        {t($language, 'bindingStep', {
          step: sequence + 1,
          total: BIND_ORDER.length,
          button: buttonLabels[capturing]
        })}
        <br />
        {t($language, 'pressEscToCancel')} · {t($language, 'pressTabToSkip')}
      {:else}
        {t($language, 'pressKeyToBind', { button: buttonLabels[capturing] })}
        <br />
        {t($language, 'pressEscToCancel')}
      {/if}
    </p>
  {:else if notice}
    <p class="hint">{notice}</p>
  {:else if player === 2 && assignment.gamepad === null && !assignment.keyboard}
    <p class="hint quiet">{t($language, 'playerInactive')}</p>
  {/if}

  {#each [...conflicts[editing]] as [button, others]}
    <p class="conflict">
      ⚠️ {buttonLabels[button]} — {others
        .map((o) => t($language, 'alsoUsedByPlayer', { player: o.player, button: buttonLabels[o.button] }))
        .join(' · ')}
    </p>
  {/each}
</section>

<style>
  .player {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }

  header {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  h4 {
    margin: 0;
    font-size: 1rem;
    color: #eee;
  }

  .sources {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: #ccc;
  }

  .sources label {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .sources select,
  .sources button,
  .tables button,
  .actions button {
    background: #333;
    color: #eee;
    border: 1px solid #555;
    border-radius: 6px;
    padding: 0.35rem 0.7rem;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .sources select {
    max-width: 12rem;
  }

  .tables {
    display: flex;
    gap: 0.25rem;
  }

  .tables button.on {
    background: #1976d2;
    border-color: #1976d2;
    font-weight: 600;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .hint {
    margin: 0;
    background: #1976d2;
    color: white;
    padding: 0.6rem 0.75rem;
    border-radius: 6px;
    text-align: center;
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .hint.quiet {
    background: rgba(255, 255, 255, 0.08);
    color: #bbb;
  }

  .conflict {
    margin: 0;
    font-size: 0.8rem;
    color: #ff8a80;
    padding: 0.4rem 0.5rem;
    background: rgba(211, 47, 47, 0.15);
    border-left: 3px solid #d32f2f;
    border-radius: 4px;
  }

  button:disabled,
  select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
```

- [ ] **Step 3: Vérifier la compilation des types**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
cd frontend && npx svelte-kit sync && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -20; cd ..
```

Attendu : aucune erreur sur `PlayerControls.svelte` ni `SnesPad.svelte`. Les erreurs sur `SoloRoom.svelte` et `LockstepRoom.svelte` sont attendues jusqu'aux Tasks 10 et 11.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/PlayerControls.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Give each player its own column of controls"
```

---

### Task 9: `ControlsSettings.svelte` devient la coquille

**Files:**
- Modify: `frontend/src/lib/components/ControlsSettings.svelte` (réécriture ; de 727 lignes à ~230)

**Interfaces:**
- Consumes: `PlayerControls` (Task 8), `binding.ts`, `devices.ts`
- Produces: props `roomId: string`, `currentConfig: ControlsConfig` ; événement `saved` (`{ config: ControlsConfig }`)

- [ ] **Step 1: Ajouter les clés i18n manquantes**

Dans `frontend/src/lib/i18n/translations.ts`, `en` puis `fr` :

```ts
    twoPlayerControlsHint: 'Player 2 plays as soon as it has a device.',
```
```ts
    twoPlayerControlsHint: 'Le joueur 2 joue dès qu\'il a un périphérique.',
```

- [ ] **Step 2: Réécrire le composant**

Remplacer tout le contenu de `frontend/src/lib/components/ControlsSettings.svelte` par :

```svelte
<script lang="ts">
  /**
   * La coquille : deux joueurs, les conflits entre eux, la sauvegarde.
   *
   * Tout ce qui concerne un seul joueur est dans PlayerControls, et tout ce
   * qui concerne un seul bouton dans SnesPad. Ce qui reste ici est ce qui ne
   * peut appartenir à personne d'autre : la config des deux joueurs, les
   * conflits qui les traversent, et l'aller-retour avec le serveur.
   *
   * Monté dans deux conteneurs de largeurs très différentes - une section de
   * page de profil et le panneau de pause de 20 rem - donc il interroge sa
   * propre largeur et non celle de la fenêtre.
   */
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { socket } from '$lib/api/socket';
  import { language } from '$lib/stores/language';
  import { t } from '$lib/i18n/translations';
  import ConfirmModal from './ConfirmModal.svelte';
  import PlayerControls from './PlayerControls.svelte';
  import { createLogger } from '$lib/utils/logger';
  import {
    findConflicts,
    normaliseControlsConfig,
    type ControlsConfig,
    type PlayerControls as PlayerControlsConfig
  } from '$lib/controls/binding';
  import {
    connectedPads,
    loadAssignments,
    resolveSources,
    saveAssignments,
    type Assignment,
    type Assignments,
    type PadInfo
  } from '$lib/znet/devices';

  export let roomId: string = '';
  export let currentConfig: ControlsConfig;

  const dispatch = createEventDispatcher<{ saved: { config: ControlsConfig } }>();
  const logger = createLogger('ControlsSettings');

  let workingConfig: ControlsConfig = normaliseControlsConfig(currentConfig);
  let assignments: Assignments = { p1: { keyboard: true, gamepad: 'auto' }, p2: { keyboard: false, gamepad: null } };
  let pads: PadInfo[] = [];
  let isSaving = false;
  let isLoading = false;
  let errorMessage = '';
  let showResetConfirm = false;
  /**
   * Which player is mid-capture, not merely whether someone is.
   *
   * Each PlayerControls mounts its own `svelte:window on:keydown`, so two
   * simultaneous captures would both consume the same keypress and write it
   * into both players' configs. Knowing *which* player is capturing lets the
   * other one be made busy, which is what keeps the two apart.
   */
  let capturingPlayer: 1 | 2 | null = null;
  /** Quel joueur est visible quand le conteneur est trop étroit pour les deux. */
  let tab: 1 | 2 = 1;

  function refreshPads() {
    pads = connectedPads();
  }

  onMount(() => {
    assignments = loadAssignments(localStorage);
    refreshPads();
    window.addEventListener('gamepadconnected', refreshPads);
    window.addEventListener('gamepaddisconnected', refreshPads);
  });

  onDestroy(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('gamepadconnected', refreshPads);
    window.removeEventListener('gamepaddisconnected', refreshPads);
  });

  $: sources = resolveSources(assignments, pads);
  $: conflicts = findConflicts(workingConfig, sources);
  $: hasChanges = JSON.stringify(workingConfig) !== JSON.stringify(normaliseControlsConfig(currentConfig));
  $: canSave = hasChanges && conflicts.count === 0 && capturingPlayer === null;

  /** A player is busy while the *other* one is binding, never while it is. */
  function busyFor(player: 1 | 2): boolean {
    return isSaving || isLoading || (capturingPlayer !== null && capturingPlayer !== player);
  }

  function onCapturing(player: 1 | 2, active: boolean) {
    if (active) capturingPlayer = player;
    else if (capturingPlayer === player) capturingPlayer = null;
  }

  function onPlayerChange(player: 1 | 2, controls: PlayerControlsConfig) {
    workingConfig = { ...workingConfig, [player === 1 ? 'p1' : 'p2']: controls };
  }

  function onAssign(player: 1 | 2, assignment: Assignment) {
    assignments = { ...assignments, [player === 1 ? 'p1' : 'p2']: assignment };
    // Écrit tout de suite : l'assignation vit sur la machine, pas dans la
    // config du compte, donc elle n'attend pas le bouton « enregistrer ».
    saveAssignments(localStorage, assignments);
  }

  async function saveConfig() {
    isSaving = true;
    errorMessage = '';
    try {
      const response = await fetch('/api/user/controls', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(workingConfig)
      });
      if (!response.ok) throw new Error('Failed to save controls');

      // Le salon ne transporte qu'un mappage par membre : celui du J1.
      if (roomId && $socket) {
        $socket.emit('room:updateKeyConfig', { roomId, keyConfig: workingConfig.p1.keys });
      }

      currentConfig = workingConfig;
      dispatch('saved', { config: workingConfig });
    } catch (error) {
      logger.error('Error saving controls:', error);
      errorMessage = t($language, 'failedToSaveControls');
    } finally {
      isSaving = false;
    }
  }

  async function handleResetConfirm() {
    showResetConfirm = false;
    isLoading = true;
    errorMessage = '';
    try {
      const response = await fetch('/api/user/controls/reset', {
        method: 'POST',
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to reset controls');

      const data = await response.json();
      workingConfig = normaliseControlsConfig(data.config);
      if (roomId && $socket) {
        $socket.emit('room:updateKeyConfig', { roomId, keyConfig: workingConfig.p1.keys });
      }
      currentConfig = workingConfig;
      dispatch('saved', { config: workingConfig });
    } catch (error) {
      logger.error('Error resetting controls:', error);
      errorMessage = t($language, 'failedToResetControls');
    } finally {
      isLoading = false;
    }
  }
</script>

<div class="controls-settings">
  <p class="lead">{t($language, 'twoPlayerControlsHint')}</p>

  <!-- Les onglets ne servent qu'en dessous du seuil ; le CSS les masque au
       large, où les deux colonnes tiennent côte à côte. -->
  <div class="tabs">
    <button type="button" class:on={tab === 1} on:click={() => (tab = 1)}>
      {t($language, 'player1')}
    </button>
    <button type="button" class:on={tab === 2} on:click={() => (tab = 2)}>
      {t($language, 'player2')}
    </button>
  </div>

  <div class="players">
    <div class="column" class:hidden-narrow={tab !== 1}>
      <PlayerControls
        player={1}
        controls={workingConfig.p1}
        assignment={assignments.p1}
        sources={sources.p1}
        {pads}
        conflicts={conflicts.p1}
        allowAuto={true}
        busy={busyFor(1)}
        on:change={(e) => onPlayerChange(1, e.detail.controls)}
        on:assign={(e) => onAssign(1, e.detail.assignment)}
        on:capturing={(e) => onCapturing(1, e.detail.active)}
      />
    </div>
    <div class="column" class:hidden-narrow={tab !== 2}>
      <PlayerControls
        player={2}
        controls={workingConfig.p2}
        assignment={assignments.p2}
        sources={sources.p2}
        {pads}
        conflicts={conflicts.p2}
        allowAuto={false}
        busy={busyFor(2)}
        on:change={(e) => onPlayerChange(2, e.detail.controls)}
        on:assign={(e) => onAssign(2, e.detail.assignment)}
        on:capturing={(e) => onCapturing(2, e.detail.active)}
      />
    </div>
  </div>

  {#if conflicts.count > 0}
    <div class="conflict-warning">
      ⚠️ {t($language, 'conflictingAssignments', { count: conflicts.count })}
    </div>
  {/if}

  {#if errorMessage}
    <div class="error-message">{errorMessage}</div>
  {/if}

  <div class="actions">
    <button
      class="btn-reset"
      on:click={() => (showResetConfirm = true)}
      disabled={isLoading || isSaving || capturingPlayer !== null}
    >
      {isLoading ? t($language, 'resetting') : t($language, 'resetToDefaults')}
    </button>
    <button class="btn-save" on:click={saveConfig} disabled={!canSave || isSaving}>
      {isSaving ? t($language, 'saving') : t($language, 'saveChanges')}
    </button>
  </div>
</div>

<style>
  .controls-settings {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    /* Monté dans une section de page large et dans le panneau de pause de
       20 rem : il doit répondre de sa propre largeur, pas de celle de la
       fenêtre. Sans danger ici - rien n'est en position absolue, et la modale
       de confirmation est un frère, pas un descendant. */
    container-type: inline-size;
  }

  .lead {
    margin: 0;
    font-size: 0.85rem;
    color: #aaa;
  }

  .players {
    display: grid;
    /* minmax(0, 1fr) et non 1fr : un 1fr nu vaut minmax(auto, 1fr), et ce
       plancher auto laisse un SVG repousser sa colonne. */
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 2rem;
  }

  .column {
    min-width: 0;
  }

  .tabs {
    display: none;
    gap: 0.25rem;
  }

  .tabs button,
  .actions button {
    background: #333;
    color: #eee;
    border: 1px solid #555;
    border-radius: 6px;
    padding: 0.45rem 0.9rem;
    font-size: 0.9rem;
    cursor: pointer;
  }

  .tabs button.on {
    background: #1976d2;
    border-color: #1976d2;
    font-weight: 600;
  }

  /* Deux dessins de 520 unités ont besoin de deux fois ~22 rem. En dessous,
     un seul joueur à la fois, sinon les libellés sur les boutons deviennent
     illisibles - et c'est le panneau de pause qui est concerné. */
  @container (max-width: 46rem) {
    .players {
      grid-template-columns: minmax(0, 1fr);
    }

    .tabs {
      display: flex;
    }

    .column.hidden-narrow {
      display: none;
    }
  }

  .conflict-warning {
    background: rgba(255, 152, 0, 0.2);
    border: 2px solid #ff9800;
    color: #ffb74d;
    padding: 0.75rem;
    border-radius: 6px;
    text-align: center;
    font-size: 0.9rem;
  }

  .error-message {
    background: #d32f2f;
    color: white;
    padding: 0.75rem;
    border-radius: 6px;
    text-align: center;
    font-size: 0.9rem;
  }

  .actions {
    display: flex;
    gap: 1rem;
  }

  .actions button {
    flex: 1;
    padding: 0.8rem;
    font-weight: 500;
  }

  .btn-save {
    background: #4caf50;
    border-color: #4caf50;
    color: white;
  }

  .actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>

{#if showResetConfirm}
  <ConfirmModal
    title={t($language, 'resetControls')}
    message={t($language, 'confirmResetControls')}
    confirmText={t($language, 'reset')}
    cancelText={t($language, 'cancel')}
    danger={true}
    on:confirm={handleResetConfirm}
    on:cancel={() => (showResetConfirm = false)}
  />
{/if}
```

- [ ] **Step 3: Vérifier les types**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -20; cd ..
```

Attendu : aucune erreur sur `ControlsSettings.svelte`. Les appelants (profil, salle, pause) sont encore sur `KeyConfig` : erreurs attendues, corrigées en Task 10.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/ControlsSettings.svelte frontend/src/lib/i18n/translations.ts
git commit -m "Turn the controls panel into a shell around two players"
```

---

### Task 10: Les appelants

**Files:**
- Modify: `frontend/src/routes/profile/+page.svelte:33,195`
- Modify: `frontend/src/routes/room/[id]/+page.svelte:44,59,66,489,784-800`
- Modify: `frontend/src/lib/components/PauseMenu.svelte:380`
- Modify: `frontend/src/lib/components/LockstepRoom.svelte:136-137,512-513,1090-1097,1252,1260-1267`
- Modify: `frontend/src/lib/components/P2PRoom.svelte:1128` (relais de `controls` vers `PauseMenu`)

Le principe : la **couture**. Tout ce qui n'est pas le nouveau panneau continue de voir une `KeyConfig` unique — celle du J1.

- [ ] **Step 1: La page de profil**

```svelte
  // Avant : let keyConfig: KeyConfig | null = null;
  let controlsConfig: ControlsConfig | null = null;
```

L'import passe à `import { normaliseControlsConfig, type ControlsConfig } from '$lib/controls/binding';`, la réponse de `/api/user/controls` est passée à `normaliseControlsConfig`, et le montage devient :

```svelte
  <ControlsSettings
    currentConfig={controlsConfig}
    on:saved={(e) => (controlsConfig = e.detail.config)}
  />
```

- [ ] **Step 2: La page de salle**

`userKeyConfig: KeyConfig` devient `userControls: ControlsConfig`, alimenté par `normaliseControlsConfig(config)` à la ligne 489. La variable `keyConfig` — celle qui descend dans les émulateurs — devient explicitement celle du J1 :

```svelte
  /**
   * Le mappage du joueur 1.
   *
   * Le protocole de salle ne transporte qu'un mappage par membre : un pair
   * distant occupe le port 2, pas un second joueur local. Les émulateurs
   * n'ont donc jamais besoin d'autre chose que de cette moitié.
   */
  $: keyConfig = currentPlayer?.keyConfig || userControls.p1.keys;
```

`SoloRoom` reçoit en plus la config entière :

```svelte
  <SoloRoom
    {roomId}
    gameId={chosenGame.id}
    gameCrc32={chosenGame.crc32}
    gameTitle={chosenGame.title}
    controls={userControls}
    {resumeSaveId}
  />
```

`LockstepRoom`, `P2PRoom` et les émulateurs RetroArch gardent `{keyConfig}` inchangé.

- [ ] **Step 3: Le menu pause**

Dans `PauseMenu.svelte`, une nouvelle prop à côté du `keyConfig` existant — qui reste, parce que d'autres sous-menus s'en servent :

```svelte
  import type { ControlsConfig } from '$lib/controls/binding';

  /**
   * La config des deux joueurs, pour le sous-menu des contrôles.
   *
   * Distincte de `keyConfig`, qui est la moitié J1 que la salle transporte :
   * ce panneau-ci édite les deux joueurs, et lui donner la moitié serait lui
   * cacher le second.
   */
  export let controls: ControlsConfig;
```

Le montage ligne 380 devient :

```svelte
  <ControlsSettings {roomId} currentConfig={controls} on:saved={handleSaved} />
```

Et `handleSaved` relaie la `ControlsConfig` entière au lieu d'une `KeyConfig` :

```ts
  function handleSaved(event: CustomEvent<{ config: ControlsConfig }>) {
    controls = event.detail.config;
    dispatch('controlsSaved', { config: event.detail.config });
    showKeyConfig = false;
  }
```

La page de salle écoute `on:controlsSaved={(e) => (userControls = e.detail.config)}` sur `PauseMenu`, et `SoloRoom` fait de même (Task 11, Step 3).

### Les trois salles qui montent `PauseMenu`

`PauseMenu` est monté à **trois** endroits — `SoloRoom.svelte:694`, `LockstepRoom.svelte:1252` et `P2PRoom.svelte:1128` — donc une prop requise doit arriver dans les trois, sinon `svelte-check` casse les deux qu'on oublie. `LockstepRoom` et `P2PRoom` reçoivent donc `controls: ControlsConfig` de la page de salle et le relaient, exactement comme `SoloRoom`, et remontent `controlsSaved` de la même façon.

**Ce n'est pas une redondance avec `keyConfig`, et la distinction est la raison de l'existence des deux props :**

| Prop | Ce que c'est |
|---|---|
| `keyConfig` | ce que **le salon** dit du mappage de ce membre — `currentPlayer?.keyConfig`, qui en netplay peut venir d'un autre compte que le mien |
| `controls` | **ma** config à deux joueurs, celle du compte connecté, celle que le panneau édite |

Les confondre donnerait un panneau qui édite la config d'un pair distant. `keyConfig` continue donc de servir aux émulateurs et au collecteur, `controls` ne sert qu'au sous-menu des contrôles.

En lockstep et en dual, le joueur 2 de cette config ne joue pas — c'est hors périmètre — mais il reste **éditable**, et surtout il ne doit pas être écrasé : donner au panneau une config dérivée de `keyConfig` seul remplacerait le J2 réellement enregistré par des défauts à la première sauvegarde. C'est la perte de données que ces deux props évitent.

- [ ] **Step 4: `LockstepRoom` passe par `devices.ts`**

Son sélecteur de manette (`cycleGamepadSource`, ligne 1090) écrivait dans `psnes-gamepad-source` à la main. Il passe par le module :

```ts
  import { loadAssignments, resolveSources, saveAssignments, connectedPads } from '$lib/znet';

  let assignments = loadAssignments(localStorage);

  // Au démarrage, ligne 513 :
  collector = new InputCollector(
    { keys: keyConfig, pad: STANDARD_PAD },
    resolveSources(assignments, connectedPads()).p1
  );

  /**
   * Bascule la manette du J1 entre « toutes les libres » et « aucune ».
   *
   * Le lockstep n'a qu'un joueur local par machine : le J2 de la config ne le
   * concerne pas, et ce raccourci n'a que deux positions à offrir.
   */
  function cycleGamepadSource() {
    const next = assignments.p1.gamepad === null ? 'auto' : null;
    assignments = { ...assignments, p1: { ...assignments.p1, gamepad: next } };
    saveAssignments(localStorage, assignments);
    collector?.setSources(resolveSources(assignments, connectedPads()).p1);
  }

  function gamepadLabel() {
    return assignments.p1.gamepad === null ? t($language, 'noController') : t($language, 'allFreeControllers');
  }
```

L'appel du gabarit ligne 1260 devient `gamepadLabel={gamepadLabel()}`.

- [ ] **Step 5: Vérifier les types**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -20; cd ..
```

Attendu : plus aucune erreur, sauf sur `SoloRoom.svelte` (prop `controls` pas encore acceptée) — corrigée en Task 11.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/profile/+page.svelte "frontend/src/routes/room/[id]/+page.svelte" frontend/src/lib/components/PauseMenu.svelte frontend/src/lib/components/LockstepRoom.svelte frontend/src/lib/components/P2PRoom.svelte
git commit -m "Hand each caller the half of the config it needs"
```

---

### Task 11: `SoloRoom` alimente le port 2

**Files:**
- Modify: `frontend/src/lib/components/SoloRoom.svelte:36,45,91,130,399-411`

- [ ] **Step 1: Remplacer la prop et l'état**

```svelte
  import { normaliseControlsConfig, type ControlsConfig } from '$lib/controls/binding';
  import { loadAssignments, resolveSources, connectedPads, isPlayerActive } from '$lib/znet';

  export let controls: ControlsConfig;

  let collector1: InputCollector | null = null;
  let collector2: InputCollector | null = null;
  let assignments = loadAssignments(localStorage);
```

Remplacer la ligne 130 (`$: if (collector && keyConfig) collector.setKeyConfig(keyConfig);`) par :

```svelte
  $: if (collector1 && controls) collector1.setControls(controls.p1);
  $: if (collector2 && controls) collector2.setControls(controls.p2);
```

- [ ] **Step 2: Deux collecteurs, et la ligne que le commentaire annonçait**

Remplacer les lignes 399-411 par :

```ts
      assignments = loadAssignments(localStorage);
      applySources();

      collector1 = new InputCollector(controls.p1, resolveSources(assignments, connectedPads()).p1);
      collector1.attach();
      // Créé même quand le J2 est muet : ses sources sont alors vides, il rend
      // 0, et l'assigner en cours de partie n'a plus qu'à pousser des sources.
      collector2 = new InputCollector(controls.p2, resolveSources(assignments, connectedPads()).p2);
      collector2.attach();

      window.addEventListener('gamepadconnected', applySources);
      window.addEventListener('gamepaddisconnected', applySources);

      session = new SoloSession({
        core,
        readLocalInput: () => ({
          pad1: collector1!.read(),
          pad2: isPlayerActive(assignments.p2) ? collector2!.read() : 0
        }),
        onFrame: () => {
          renderer!.draw(core!);
          audio!.push(core!.audio());
        }
      });
```

Et la fonction, à côté des autres helpers :

```ts
  /**
   * Repousse les sources dans les deux collecteurs.
   *
   * Rebrancher une manette pendant une partie doit se voir : sans ça, un pad
   * assigné au J2 et rebranché resterait muet jusqu'à la fin de la session.
   */
  function applySources() {
    assignments = loadAssignments(localStorage);
    const sources = resolveSources(assignments, connectedPads());
    collector1?.setSources(sources.p1);
    collector2?.setSources(sources.p2);
  }
```

Dans `teardown()`, retirer les deux écouteurs et détacher les deux collecteurs.

- [ ] **Step 3: Le menu pause de la salle solo**

Le montage de `PauseMenu` dans `SoloRoom.svelte` gagne la config et l'écoute du retour :

```svelte
  <PauseMenu
    {roomId}
    keyConfig={controls.p1.keys}
    {controls}
    on:controlsSaved={(e) => (controls = e.detail.config)}
    ...
  />
```

Réaffecter `controls` déclenche les deux `setControls` réactifs de l'étape 1 : une liaison changée en pause prend effet à la reprise, sans redémarrer la session ni recharger la ROM. C'est le point à vérifier à l'étape 5 de la Task 12.

- [ ] **Step 4: Vérifier types et tests**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
cd frontend && npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -10; cd ..
npm run test:all 2>&1 | tail -6
```

Attendu : `svelte-check` sans erreur, `fail 0` sur toute la suite.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/SoloRoom.svelte
git commit -m "Let the second controller reach the second port"
```

---

### Task 12: Vérification dans l'app

**Files:** aucun changement de code attendu — les correctifs éventuels vont dans la tâche concernée.

Aucun test n'atteint le câblage `.svelte` : `SoloRoom` doit être vu tourner.

### Ce que cet environnement peut prouver, et ce qu'il ne peut pas

Constaté avant de lancer la vérification, plutôt que découvert pendant :

- **Le core est là** — `frontend/static/psnes-core/psnes_core.wasm` est committé, donc l'émulateur tourne dans le navigateur. Les 11 tests ignorés de `test:core` sont une autre affaire : ils veulent une construction chargeable par node sous `core/build/`, absente ici.
- **Il n'y a aucune ROM, et il n'y en aura pas.** L'application exige que le joueur possède ses jeux ; le dépôt n'en distribue pas. Donc **tout ce qui demande une partie en cours échappe à un agent** : « `IJKL` déplace le second personnage », l'effet d'une liaison changée au menu pause, et l'assignation du J2 en cours de partie.
- **Une vraie manette ne peut pas être branchée depuis un script.** Doubler `navigator.getGamepads` dans la page couvre en revanche sérieusement le panneau, qui sonde cette API : « Détecter », le surlignage en direct et la séparation des deux joueurs sont vérifiables ainsi. Le branchement physique à chaud, non.

Entièrement vérifiable ici, et à faire : le panneau contre un vrai backend et une vraie base, la migration d'une config v1, les deux langues, les deux largeurs, la détection de conflits, la porte de sauvegarde, et le sondage des pads doublé.

Le reste part dans une **liste de reprise pour le propriétaire** — courte, précise, chaque ligne disant quoi faire et quoi observer — plutôt que dans une affirmation de réussite.

- [ ] **Step 1: Lever les cinq obstacles du worktree**

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
# 1 & 2 : les node_modules (déjà en place si le baseline a été lancé)
ls -ld node_modules backend/node_modules frontend/node_modules

# 3 : fs.allow, sinon la page est blanche sans erreur
cat > frontend/vite.worktree.config.ts <<'EOF'
import { mergeConfig } from 'vite';
import base from './vite.config';
export default mergeConfig(base, {
  server: { fs: { allow: ['/home/pleymor/projects/psnes-repos/psnes'] } }
});
EOF

# 4 : la base et le backend sur un port libre
export DATABASE_URL="file:/tmp/psnes-2p/dev.db"
mkdir -p /tmp/psnes-2p
(cd backend && npx tsx src/db/migrate-cli.ts)
(cd backend && AUTH_MODE=dev NODE_ENV=development REDIS_HOST=localhost PORT=3100 npx tsx src/index.ts &)
(cd frontend && BACKEND_URL=http://localhost:3100 npx vite dev --config vite.worktree.config.ts --port 5273 &)
```

- [ ] **Step 2: Les deux pads côte à côte, dans les deux langues**

Ouvrir `http://localhost:5273/profile`, se connecter en mode dev, et vérifier :

- les deux colonnes s'affichent côte à côte, de largeurs égales ;
- le J2 montre ses défauts `IJKL` / `GHBN` / `TY` / `OU` et la phrase « le port 2 reste muet » ;
- cocher `Clavier` sur le J2 fait disparaître cette phrase ;
- basculer la langue en anglais ne laisse aucune chaîne en français.

Capture d'écran de chaque langue.

- [ ] **Step 3: Le second joueur joue vraiment**

Démarrer une partie solo sur un jeu à deux joueurs, appuyer sur `Start` pour le mode deux joueurs, et vérifier que `IJKL` déplace **le second** personnage et non le premier. C'est la vérification qui compte : tout le reste peut être juste et cette ligne fausse.

- [ ] **Step 4: Distinguer deux manettes**

Avec une manette branchée : sur le J2, cliquer `Détecter`, appuyer sur un bouton, vérifier que le `<select>` affiche le nom du pad. Basculer sur l'onglet `Manette` du J2, appuyer sur ses boutons et vérifier que le dessin **du J2** s'allume — et que celui du J1 ne s'allume pas.

- [ ] **Step 5: Le panneau de pause**

En cours de partie, ouvrir le menu pause → Contrôles, et vérifier : les onglets J1/J2 remplacent les deux colonnes, les libellés sur les boutons restent lisibles, et une liaison modifiée puis sauvegardée prend effet à la reprise.

- [ ] **Step 5b: Le J2 assigné *en cours de partie***

C'est le chemin qu'aucun test n'atteint, et celui qu'une relecture a prédit cassé : démarrer une partie solo avec le **J2 muet** (aucun périphérique), ouvrir le menu pause → Contrôles, donner au J2 le clavier — ou un pad déjà branché —, reprendre, et confirmer que le J2 répond **sans recharger la page**.

L'étape 2 assigne le J2 depuis le profil *avant* le lancement du jeu, donc elle passerait sans jamais exercer ce cas. Vérifier aussi la réciproque, qui a le même mécanisme : couper la manette du J1 depuis le menu pause doit la rendre muette à la reprise, et non la laisser active.

- [ ] **Step 6: La compatibilité d'une vieille config**

Écrire une `KeyConfig` v1 directement en base pour l'utilisateur de dev, recharger le profil, et vérifier qu'elle apparaît comme le J1 avec un J2 par défaut :

```bash
export PATH="/home/pleymor/.nvm/versions/node/v20.19.6/bin:$PATH"
node -e "
const db = require('better-sqlite3')('/tmp/psnes-2p/dev.db');
db.prepare('UPDATE \"User\" SET controlsConfig = ?').run(JSON.stringify({
  up:'ArrowUp',down:'ArrowDown',left:'ArrowLeft',right:'ArrowRight',
  a:'Gamepad0Button2',b:'KeyZ',x:'KeyS',y:'KeyA',
  l:'KeyQ',r:'KeyW',start:'Enter',select:'ShiftRight'
}));
console.log('v1 écrite');
"
```

Attendu à l'écran : le J1 a `A` non lié côté clavier, et `B2` sur son bouton A côté manette.

- [ ] **Step 7: Ranger**

```bash
rm -f frontend/vite.worktree.config.ts
rm -rf frontend/.svelte-kit test-results
git status --short
```

Attendu : rien d'inattendu hors les liens symboliques `node_modules`, qui ne se committent jamais.

- [ ] **Step 8: Rapport**

Rendre compte au propriétaire : ce qui a été vu tourner, les captures, et ce qui reste ouvert. Ne rien fusionner sans son accord.

---

## Ce que ce plan ne fait pas

- **Le netplay à deux joueurs locaux.** En lockstep, chaque machine n'envoie qu'un pad ; le port 2 d'une salle est un pair distant. Chantier séparé, décidé comme tel.
- **Les modes streaming et dual.** Ils continuent sur `p1.keys`, via la couture de la Task 10.
- **Le pad tactile** (`virtual-gamepad.ts`) : inchangé, et exclu de la capture comme aujourd'hui.
- **Des profils de contrôles nommés.**
