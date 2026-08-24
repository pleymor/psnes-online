/**
 * The binding vocabulary, and the one door every config comes through.
 *
 * Two families of codes that never mix inside one table: the keyboard's
 * `event.code`s, and controller codes relative to the player's own pad. The
 * device index is no longer part of a binding - that is what lets you replug
 * controllers in a different order without losing a mapping, and what lets two
 * players share a binding on two different pads.
 *
 * Everything arriving from the database or the network passes through
 * `normaliseControlsConfig` before it is read. Nothing else may assume a shape.
 */

import type { KeyConfig } from '$lib/types';

export const BUTTONS = [
	'up', 'down', 'left', 'right',
	'a', 'b', 'x', 'y',
	'l', 'r', 'start', 'select'
] as const;

export type Button = (typeof BUTTONS)[number];

/** One list of controller codes per SNES button. Empty list means unbound. */
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
 * The second player on the keyboard.
 *
 * Described by physical position - `event.code` ignores the layout, and none of
 * these codes is touched by the AZERTY permutation:
 *
 *     T Y          U I O        T=L  Y=R      I=up    J=left
 *     G H          J K L        G=Y  H=X      K=down  L=right
 *     B N                       B=B  N=A      U=Select  O=Start
 *
 * No intersection with DEFAULT_P1_KEYS: two players sharing one keyboard is the
 * commonest local case, and it has to work without anyone touching anything.
 */
export const DEFAULT_P2_KEYS: KeyConfig = {
	up: 'KeyI', down: 'KeyK', left: 'KeyJ', right: 'KeyL',
	a: 'KeyN', b: 'KeyB', x: 'KeyH', y: 'KeyG',
	l: 'KeyT', r: 'KeyY', start: 'KeyO', select: 'KeyU'
};

/**
 * What a controller is mapped to before anyone rebinds anything.
 *
 * This is `znet/input.ts`'s `GAMEPAD_BITS` table made visible and editable, the
 * axes included: the old read treated the hat (buttons 12 to 15) *and* the left
 * stick (axes 0 and 1) as the d-pad. An XInput controller reports both. Keeping
 * only one of them would cut the stick.
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
 * Translates a binding from when the device index lived inside it.
 *
 * Dropping the index is safe: `0` is the only value the old capture could
 * realistically produce, since it renumbered physical pads from zero.
 */
export function legacyToPadCode(code: string): string | null {
	const button = LEGACY_BUTTON.exec(code);
	if (button) return `PadButton${button[1]}`;
	const axis = LEGACY_AXIS.exec(code);
	if (axis) return `PadAxis${axis[1]}${axis[2]}`;
	return null;
}

/**
 * A deep copy of a controller table.
 *
 * `{ ...pad }` will not do: the values are arrays, and a spread would share them
 * with the source - `STANDARD_PAD` included, which is a module constant.
 * Nothing mutates them in place today; this exists so that it stays harmless if
 * one day something does.
 */
export function clonePad(source: PadConfig): PadConfig {
	const out = {} as PadConfig;
	for (const button of BUTTONS) out[button] = [...source[button]];
	return out;
}

/**
 * Removes `code` from the controller list of every button other than `owner`.
 *
 * Called right after a legacy code has been migrated onto `owner`: the player
 * aimed at that button deliberately, and the code cannot stay elsewhere in the
 * same table without becoming a conflict nobody chose. The consequence - some
 * other button loses a binding it held from the standard mapping - is the
 * honest price of having rebound onto its code, and it beats a panel that
 * refuses to save.
 */
function releasePadCodeFromOthers(pad: PadConfig, owner: Button, code: string): void {
	for (const button of BUTTONS) {
		if (button === owner) continue;
		if (pad[button].includes(code)) {
			pad[button] = pad[button].filter((existing) => existing !== code);
		}
	}
}

function defaultPlayer(keys: KeyConfig): PlayerControls {
	return { keys: { ...keys }, pad: clonePad(STANDARD_PAD) };
}

export function defaultControlsConfig(): ControlsConfig {
	return { version: 2, p1: defaultPlayer(DEFAULT_P1_KEYS), p2: defaultPlayer(DEFAULT_P2_KEYS) };
}

/** True when the object has all twelve buttons as strings - the v1 shape. */
function looksLikeKeyConfig(raw: Record<string, unknown>): boolean {
	return BUTTONS.every((button) => typeof raw[button] === 'string');
}

/**
 * A v1 config: keyboard codes stay, controller codes move out.
 *
 * A controller code found in the keyboard table cannot stay there - nothing
 * would ever read it - and the keyboard slot it occupied becomes unbound rather
 * than receiving a default the player never chose.
 *
 * An empty string is taken as it is, not skipped: it means *unbound* everywhere
 * else in this module, and substituting the default would resurrect a binding
 * the player had deliberately removed. The server's copy
 * (`backend/src/utils/key-config.ts`) does the same, and the two must agree.
 */
function playerFromLegacyKeys(raw: Record<string, unknown>, defaults: KeyConfig): PlayerControls {
	const player = defaultPlayer(defaults);
	for (const button of BUTTONS) {
		const value = raw[button];
		if (typeof value !== 'string') continue;
		const padCode = legacyToPadCode(value);
		if (padCode) {
			player.pad[button] = [padCode];
			releasePadCodeFromOthers(player.pad, button, padCode);
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
			releasePadCodeFromOthers(player.pad, button, migrated);
			player.keys[button] = '';
		} else {
			player.keys[button] = key;
		}
	}

	return player;
}

/**
 * Forces anything into the v2 shape.
 *
 * Three possible inputs and one output: a v2 config (normalised slot by slot), a
 * bare one-player `KeyConfig` from before, or anything else - which yields the
 * defaults. Idempotent, which the tests require: it runs on every read,
 * including on its own output.
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

/* --------------------------------------------------------------- display */

export type CodeDescription =
	| { kind: 'keyboard'; code: string }
	| { kind: 'padButton'; index: number }
	| { kind: 'padAxis'; index: number; dir: 'plus' | 'minus' }
	| { kind: 'unbound' };

/**
 * What a code is, without saying what to call it.
 *
 * The component translates; this module stays testable with no language store.
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

/** Keys whose short name cannot be derived from the code. */
const SHORT_KEYS: Record<string, string> = {
	ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
	Enter: '⏎', NumpadEnter: '⏎', Space: '␣', Tab: '⇥', Backspace: '⌫', Escape: 'Esc',
	ShiftLeft: '⇧G', ShiftRight: '⇧D',
	ControlLeft: '⌃G', ControlRight: '⌃D',
	AltLeft: '⌥G', AltRight: '⌥D'
};

/** Three characters, the width of the button this is drawn on. */
const MAX_SHORT = 3;

/**
 * What gets written on a button of the drawing.
 *
 * Short out of necessity: in the pause panel the drawing is 280px wide, and a
 * label longer than three characters does not fit. The long form exists, in the
 * `aria-label`.
 *
 * Hence the clamp: `Semicolon`, `BracketLeft`, `F1`, `Comma`, or a
 * `NumpadDivide` that the prefix only shortens to `NDivide`, all overflowed the
 * button for want of a `SHORT_KEYS` entry. That dictionary's values are
 * hand-picked, already fit, and do not go through the clamp.
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
			if (described.code.startsWith('Key')) return described.code.slice(3, 3 + MAX_SHORT);
			if (described.code.startsWith('Digit')) return described.code.slice(5, 5 + MAX_SHORT);
			if (described.code.startsWith('Numpad')) return `N${described.code.slice(6)}`.slice(0, MAX_SHORT);
			return described.code.slice(0, MAX_SHORT);
		}
	}
}

export function shortLabelList(codes: string[]): string {
	const bound = codes.filter((code) => code !== '');
	if (bound.length === 0) return '—';
	const extra = bound.length - 1;
	return extra > 0 ? `${shortLabel(bound[0])} +${extra}` : shortLabel(bound[0]);
}

/* ------------------------------------------------------------- conflicts */

/** The pads a player listens to. `'all'` means every connected one. */
export type PadSelection = number[] | 'all';

export interface InputSources {
	keyboard: boolean;
	pads: PadSelection;
}

export interface ConflictOwner {
	player: 1 | 2;
	button: Button;
}

/** Per conflicting button: the other bindings taking its code. */
export type ConflictMap = Map<Button, ConflictOwner[]>;

export interface ConflictReport {
	p1: { keys: ConflictMap; pad: ConflictMap };
	p2: { keys: ConflictMap; pad: ConflictMap };
	/** Number of conflicting slots, across both tables. */
	count: number;
}

function padsOverlap(a: PadSelection, b: PadSelection): boolean {
	if (a === 'all' || b === 'all') {
		// Two `'all'`s overlap even with nothing plugged in: the first pad to
		// appear would be grabbed by both. An explicitly empty list, by
		// contrast, listens to nothing and overlaps nothing.
		return a === 'all' ? b === 'all' || b.length > 0 : a.length > 0;
	}
	return a.some((index) => b.includes(index));
}

/** Every binding in a table, one entry per code. */
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
 * Who steps on whose toes, and for whom that is a problem.
 *
 * Two rules, and the second is the one that matters:
 *
 * - inside one player, a duplicated code is always a conflict, even when that
 *   player is inactive;
 * - between players, a shared code is a conflict only if both can reach it -
 *   the keyboard on both sides, or pad sets that intersect. Without that second
 *   rule, two players on the standard mapping would conflict on all twelve
 *   buttons and nothing could ever be saved.
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
				// Accumulate: a button whose controller list holds two codes can
				// conflict twice, and overwriting the previous entry would lose
				// half the message. Deduplicated by (player, button), or the
				// same culprit would be cited twice.
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
