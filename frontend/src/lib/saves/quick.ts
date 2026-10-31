import type { SaveSummary } from './api';
// Relative, not `$lib`: unit-tested from `core/test`, which runs under plain
// node and cannot resolve SvelteKit's alias.
import type { KeyConfig } from '../types';
import { handheld, type XrCapableNavigator } from '../vr/support';

/**
 * The one save the F2/F4 shortcuts read and write.
 *
 * A fixed sentinel rather than a translated label, and that is the whole
 * reason it is stored under a name nobody would type: `SaveGrid` shows the
 * translated wording, but a player switching language must not orphan the
 * quick save they already have and start a second one. There is meant to be
 * exactly one per game.
 *
 * The double underscore also keeps it clear of `autoSaveName`, which only ever
 * produces locale date strings.
 */
export const QUICK_SAVE_NAME = '__quick__';

/** This game's quick save, if one has been taken. */
export function findQuickSave(saves: SaveSummary[]): SaveSummary | undefined {
	return saves.find((s) => s.name === QUICK_SAVE_NAME);
}

/**
 * Whether the player has bound this key to a pad button.
 *
 * F2 and F4 are our default, not their choice, so a player who mapped one of
 * them in the controls screen keeps it: the shortcut stands down rather than
 * firing a save on every shot. `keyConfig` is optional because the room has
 * none until the player's settings have loaded.
 */
export function padUsesKey(keyConfig: KeyConfig | undefined | null, code: string): boolean {
	if (!keyConfig) return false;
	return Object.values(keyConfig).includes(code);
}

/** The default bindings, named so both rooms and any future settings agree. */
export const QUICK_SAVE_KEY = 'F2';
export const QUICK_LOAD_KEY = 'F4';

/** What the pause menu shows beside its two save entries; null hides one. */
export interface QuickKeyHints {
	save: string | null;
	load: string | null;
}

/**
 * The quick keys worth telling this player about, read from the same rule the
 * rooms fire them by.
 *
 * `keyConfigs` is every binding the room checks before acting on F2 or F4 -
 * both players in solo, P1 in lockstep - or null for a room that has no quick
 * keys at all. A key bound to a pad button stands down there, so it is not
 * advertised here either: a hint for a shortcut that does nothing is worse
 * than none.
 *
 * Nothing on a phone or a tablet, which has no keyboard to press them on. The
 * same `handheld` test that keeps the VR button off phones (#106) decides it.
 * There is no pad shortcut for either action, so there is nothing to show for
 * one.
 */
export function quickKeyHints(
	keyConfigs: ReadonlyArray<KeyConfig | undefined | null> | null,
	nav: XrCapableNavigator | undefined
): QuickKeyHints {
	if (!keyConfigs || handheld(nav)) return { save: null, load: null };
	const free = (code: string) => (keyConfigs.some((k) => padUsesKey(k, code)) ? null : code);
	return { save: free(QUICK_SAVE_KEY), load: free(QUICK_LOAD_KEY) };
}
