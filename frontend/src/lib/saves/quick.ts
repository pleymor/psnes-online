import type { SaveSummary } from './api';
// Relative, not `$lib`: unit-tested from `core/test`, which runs under plain
// node and cannot resolve SvelteKit's alias.
import type { KeyConfig } from '../types';

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
