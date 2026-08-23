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
		// Deux `'all'` se chevauchent même sans rien de branché : le premier
		// pad à apparaître serait pris par les deux. Une liste explicitement
		// vide, elle, n'écoute rien et ne chevauche rien.
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
	return { keys: new Map<Button, ConflictOwner[]>(), pad: new Map<Button, ConflictOwner[]>() };
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
					(other) =>
						(other.button !== owner.button || other.player !== owner.player) &&
						(other.player === owner.player || shared)
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
