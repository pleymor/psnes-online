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
