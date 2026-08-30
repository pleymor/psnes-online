/**
 * "My configuration", as one shape a player can carry to another machine.
 *
 * Before this module there was no such thing. The controls sat in SQLite
 * behind the account, the language and the shader in `localStorage`, the
 * picture shape nowhere at all - three lifetimes, and one of them zero. The
 * exportable set is the deliverable here; the file is the easy half.
 *
 * WHY A FILE OF ITS OWN, and not the same envelope as the saves export.
 * A configuration file is small, text, and reviewable: a player can open it,
 * read every line, and see that it holds no account of theirs. A saves archive
 * is opaque blobs measured in megabytes. Merging them would make the small
 * reviewable thing inherit the big opaque thing's size and its refusals, and
 * would put one version number across two formats that will not change at the
 * same times. Two files, two versions, two buttons.
 *
 * NOT A BACKUP. Losing data is the backup server's problem, and it is already
 * solved there. This exists so a player who moves to another machine, or to
 * another account, does not rebind twelve buttons twice by hand.
 *
 * WHAT IS NEVER IN IT: `pseudo`, `discriminator`, `avatar`, `googleId`. Those
 * are an account, not a configuration. Importing them would collide with
 * `User_pseudo_discriminator_key` and report an error about a unique index
 * rather than about anything the player did.
 *
 * THE IMPORT IS UNTRUSTED INPUT. It ends up in `config.p1.keys`, which
 * `getUserKeyConfig` hands to the room protocol, so nothing here writes what
 * it was given: the controls go back out through `PUT /api/user/controls`,
 * which validates again and, through `writeUserControls`, invalidates the
 * five-minute cache the room reads. This module writes local preferences and
 * nothing else.
 */

import type { ControlsConfig } from '$lib/controls/binding';
import { BUTTONS, DEFAULT_P1_KEYS, DEFAULT_P2_KEYS, normaliseControlsConfig } from '$lib/controls/binding';
import type { PixelAspect } from '$lib/znet/fit';
import { VALID_SHADER_IDS } from '$lib/shaders';
import type { Language } from '$lib/stores/language';
import { parseAspect, readAspectPreference, writeAspectPreference } from '$lib/stores/aspect-preference';
import { readShaderPreference, writeShaderPreference } from '$lib/stores/shader-preference';
import {
	listLatencyPreferences,
	parseLatencyMode,
	replaceLatencyPreferences,
	type EnumerableStorage,
	type LatencyMode
} from '$lib/stores/latency-preference';

/** What marks a file as ours, so a saves archive is refused by name. */
export const CONFIG_KIND = 'psnes.config';

/**
 * The format version.
 *
 * Bumped when a field changes meaning, not when one is added: a reader that
 * ignores what it does not know already handles additions, and every section
 * is optional on the way in.
 */
export const CONFIG_VERSION = 1;

/**
 * A ceiling on the file, checked before it is parsed.
 *
 * A real one is a couple of kilobytes. This is not a limit anybody can reach
 * honestly - it is there so that picking the wrong file (a ROM, a save
 * archive) costs a message rather than a parse of the whole thing.
 */
export const MAX_CONFIG_BYTES = 256 * 1024;

/** How many per-game latency choices an import may carry into the storage. */
export const MAX_LATENCY_ENTRIES = 500;

/** The longest game id an import may name. Ours are UUID-shaped. */
const MAX_GAME_ID_LENGTH = 128;

/**
 * Where the language lives. Declared here rather than imported from the
 * language store, which reaches for `$app/environment` and cannot be loaded
 * outside a SvelteKit build; the store imports these two instead, so there is
 * still exactly one definition.
 */
export const LANGUAGE_KEY = 'language';

/** A language out of anything, or null when it is not one. */
export function parseLanguage(value: unknown): Language | null {
	return value === 'en' || value === 'fr' ? value : null;
}

/* --------------------------------------------------------------- the shape */

export interface PortableDisplay {
	aspect: PixelAspect;
	shader: string;
}

/** What an export contains, and nothing else. */
export interface PortableConfig {
	kind: typeof CONFIG_KIND;
	version: number;
	exportedAt: string;
	controls: ControlsConfig;
	language: Language;
	display: PortableDisplay;
	latency: Record<string, LatencyMode>;
}

/**
 * What survived an import, section by section.
 *
 * `null` means "the file said nothing about this", which is deliberately not
 * the same as "the file asked for the default": applying a default to a
 * section a file does not carry would silently undo a setting the player never
 * exported. A value that was present but unreadable is also `null`, and says
 * so through a notice.
 */
export interface ImportedConfig {
	controls: ControlsConfig | null;
	language: Language | null;
	aspect: PixelAspect | null;
	shader: string | null;
	latency: Record<string, LatencyMode> | null;
}

/**
 * What an import wants said out loud.
 *
 * Codes rather than sentences: the component translates, and this module stays
 * testable with no language store.
 */
export type ImportNotice =
	| 'controlsDropped'
	| 'controlsKeyboardRestored'
	| 'controlsPadOnly'
	| 'languageDropped'
	| 'aspectDropped'
	| 'shaderDropped'
	| 'latencyDropped';

export type ImportRefusal = 'notJson' | 'notAConfigFile' | 'fromANewerBuild' | 'tooLarge';

export type ImportResult =
	| { ok: false; reason: ImportRefusal }
	| { ok: true; config: ImportedConfig; notices: ImportNotice[] };

/* -------------------------------------------------------------- exporting */

/** Everything durable, gathered from the three places it is kept. */
export function gatherConfig(
	storage: EnumerableStorage,
	controls: ControlsConfig,
	now: Date
): PortableConfig {
	return {
		kind: CONFIG_KIND,
		version: CONFIG_VERSION,
		exportedAt: now.toISOString(),
		controls,
		language: parseLanguage(storage.getItem(LANGUAGE_KEY)) ?? 'en',
		display: {
			aspect: readAspectPreference(storage),
			shader: readShaderPreference(storage)
		},
		latency: listLatencyPreferences(storage)
	};
}

/** Indented on purpose: the player is meant to be able to read this. */
export function serialiseConfig(config: PortableConfig): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

/** `psnes-config-2026-08-30.json`. */
export function configFileName(now: Date): string {
	return `psnes-config-${now.toISOString().slice(0, 10)}.json`;
}

/* -------------------------------------------------------------- importing */

function isPlayerish(raw: unknown): boolean {
	if (!raw || typeof raw !== 'object') return false;
	const source = raw as Record<string, unknown>;
	return (
		!!source.keys && typeof source.keys === 'object' &&
		!!source.pad && typeof source.pad === 'object'
	);
}

/**
 * Whether `raw` is recognisably a controls config at all.
 *
 * `normaliseControlsConfig` answers "the defaults" for anything it cannot
 * read, which is right on a database read - a row must always yield a playable
 * mapping - and wrong here, where it would report a successful import and hand
 * the player a mapping they never chose. So the shape is checked first, and
 * only then normalised. Both shapes count, v1 included: a config exported by
 * an older build is exactly the case this feature exists for.
 */
function looksLikeControls(raw: unknown): boolean {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
	const source = raw as Record<string, unknown>;
	if (source.version === 2) return isPlayerish(source.p1) && isPlayerish(source.p2);
	return BUTTONS.every((button) => typeof source[button] === 'string');
}

/**
 * Gives a keyboard binding back to any button that only a controller reaches.
 *
 * The trap this module was written around. Controller codes are relative to
 * the player's own pad, so they import cleanly and mean nothing on a machine
 * with no pad plugged in: a button whose keyboard slot is empty and whose pad
 * list is not simply never fires. An import that "succeeds" and then does not
 * respond is worse than one that refuses, so the button gets its default key
 * back - which costs the pad user nothing, both tables being read at once.
 *
 * Unless that default is already spoken for. Restoring it onto a code another
 * button holds would manufacture a conflict the player never chose, and the
 * panel would report it minutes later on another screen. Those buttons are
 * left as they are and counted separately, because "your pad-only bindings
 * came across" is a different thing to tell someone than "we filled the gaps".
 *
 * A button unbound on BOTH tables is left alone: that is the documented way to
 * say "nothing here" - the binding UI has a Tab-to-skip step for it - and
 * substituting a default would resurrect a binding that was deliberately
 * removed.
 */
function restoreKeyboardFallbacks(config: ControlsConfig): { restored: number; padOnly: number } {
	const taken = new Set<string>();
	for (const player of [config.p1, config.p2]) {
		for (const button of BUTTONS) {
			if (player.keys[button]) taken.add(player.keys[button]);
		}
	}

	let restored = 0;
	let padOnly = 0;
	for (const [player, defaults] of [
		[config.p1, DEFAULT_P1_KEYS] as const,
		[config.p2, DEFAULT_P2_KEYS] as const
	]) {
		for (const button of BUTTONS) {
			if (player.keys[button] !== '' || player.pad[button].length === 0) continue;
			const fallback = defaults[button];
			if (taken.has(fallback)) {
				padOnly++;
				continue;
			}
			player.keys[button] = fallback;
			taken.add(fallback);
			restored++;
		}
	}
	return { restored, padOnly };
}

function readLatencyTable(
	raw: unknown,
	notices: ImportNotice[]
): Record<string, LatencyMode> | null {
	if (raw === undefined) return null;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		notices.push('latencyDropped');
		return {};
	}

	const table: Record<string, LatencyMode> = {};
	let dropped = false;
	for (const [gameId, value] of Object.entries(raw as Record<string, unknown>)) {
		if (Object.keys(table).length >= MAX_LATENCY_ENTRIES) {
			dropped = true;
			break;
		}
		if (!gameId || gameId.length > MAX_GAME_ID_LENGTH) {
			dropped = true;
			continue;
		}
		const mode = parseLatencyMode(value);
		if (mode === null) {
			dropped = true;
			continue;
		}
		table[gameId] = mode;
	}
	if (dropped) notices.push('latencyDropped');
	return table;
}

/**
 * A file off the disk, read as strictly as it can be.
 *
 * Refuses whole rather than partly wherever the file's identity is in doubt:
 * a format from a build we do not have would otherwise be read for the fields
 * we happen to recognise, which is how an import applies three settings out of
 * five and says it worked. Once the envelope is ours, individual sections are
 * dropped one by one and each drop is reported.
 */
export function readConfigFile(text: string): ImportResult {
	if (text.length > MAX_CONFIG_BYTES) return { ok: false, reason: 'tooLarge' };

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, reason: 'notJson' };
	}

	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, reason: 'notAConfigFile' };
	}
	const source = raw as Record<string, unknown>;
	if (source.kind !== CONFIG_KIND) return { ok: false, reason: 'notAConfigFile' };

	const version = source.version;
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
		return { ok: false, reason: 'notAConfigFile' };
	}
	if (version > CONFIG_VERSION) return { ok: false, reason: 'fromANewerBuild' };

	const notices: ImportNotice[] = [];

	let controls: ControlsConfig | null = null;
	if (source.controls !== undefined) {
		if (looksLikeControls(source.controls)) {
			controls = normaliseControlsConfig(source.controls);
			const { restored, padOnly } = restoreKeyboardFallbacks(controls);
			if (restored > 0) notices.push('controlsKeyboardRestored');
			if (padOnly > 0) notices.push('controlsPadOnly');
		} else {
			notices.push('controlsDropped');
		}
	}

	let language: Language | null = null;
	if (source.language !== undefined) {
		language = parseLanguage(source.language);
		if (language === null) notices.push('languageDropped');
	}

	let aspect: PixelAspect | null = null;
	let shader: string | null = null;
	if (source.display !== undefined) {
		const display = (
			source.display && typeof source.display === 'object' ? source.display : {}
		) as Record<string, unknown>;

		if (display.aspect !== undefined) {
			aspect = parseAspect(display.aspect);
			if (aspect === null) notices.push('aspectDropped');
		}
		if (display.shader !== undefined) {
			// An id no longer in the offered list is dropped rather than stored:
			// `xbrz-freescale` was delisted after its viewport scaling produced
			// framebuffer errors, and a file may still name it.
			const id = display.shader;
			shader = typeof id === 'string' && VALID_SHADER_IDS.includes(id) ? id : null;
			if (shader === null) notices.push('shaderDropped');
		}
	}

	return {
		ok: true,
		config: { controls, language, aspect, shader, latency: readLatencyTable(source.latency, notices) },
		notices
	};
}

/**
 * Writes the local half of an import.
 *
 * The controls are deliberately absent: they are the server's, and go back out
 * through `PUT /api/user/controls`. A local write of them would leave the room
 * on player 1's previous bindings for up to five minutes.
 */
export function applyConfig(storage: EnumerableStorage, config: ImportedConfig): void {
	if (config.language !== null) storage.setItem(LANGUAGE_KEY, config.language);
	if (config.aspect !== null) writeAspectPreference(storage, config.aspect);
	if (config.shader !== null) writeShaderPreference(storage, config.shader);
	if (config.latency !== null) replaceLatencyPreferences(storage, config.latency);
}
