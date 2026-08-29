/**
 * The stored latency choice, per game.
 *
 * Which way to trade input latency against the other player's smoothness is a
 * property of the *game*, not of the link or the player. In a game where the two
 * take turns - a Mario level handed back and forth - a dropped frame on the
 * partner's screen costs nobody anything, and the lowest possible delay is
 * simply correct. In a fighting game the two interact frame by frame and both
 * need the picture steady, so the automatic loop should have its way.
 *
 * Remembered per game for that reason: set once for Mario, once for the fighter,
 * and never think about it again. Stored on the host, since the host is what
 * decides for the room.
 *
 * Takes its storage rather than reaching for `localStorage`, so it can be tested
 * without a browser - the same shape as the shader preference next door.
 */

import { MAX_INPUT_DELAY, MIN_MANUAL_DELAY } from '$lib/znet/delay-control';
import type { PreferenceStorage } from './shader-preference';

/**
 * `auto` lets the strain loop size the delay, protecting whichever player is
 * losing frames. A number pins it at that many frames, which is latency first
 * and the partner's smoothness second.
 *
 * This was `'auto' | 'low'`, where `low` meant two frames and nothing else was
 * reachable. The count is the setting now; `low` survives only as something to
 * read out of profiles written before.
 */
export type LatencyMode = 'auto' | number;

/**
 * Frames of delay `low` asks for.
 *
 * Two, not one: measured on a real 63ms link, two each ran with late frames on
 * about 5% of seconds while one each dropped a fifth of the frames in the worst
 * windows. One is still reachable by hand for anyone who wants to argue with
 * that.
 */
export const LOW_DELAY_FRAMES = 2;

const PREFIX = 'psnes-latency:';

function keyFor(gameId: string): string {
	return `${PREFIX}${gameId}`;
}

/**
 * A latency setting out of anything, or null when it is not one.
 *
 * The single place that decides what counts, because three do the asking: the
 * profile below, the field in the pause menu, and the server before it lets a
 * value into a room. Bounds are the engine's own - `setInputDelay` refuses
 * outside them - so a value this returns is one the emulator will really run,
 * and the menu can never end up displaying a number the session is not using.
 *
 * Clamping instead of refusing was the tempting shortcut and would have been a
 * lie of exactly that kind.
 */
export function parseLatencyMode(value: unknown): LatencyMode | null {
	if (value === 'auto') return 'auto';
	// The name two frames went by before the count could be chosen. Kept so a
	// profile, or a room opened by an older client, still means what it meant.
	if (value === 'low') return LOW_DELAY_FRAMES;

	if (typeof value !== 'number' && typeof value !== 'string') return null;
	const frames = typeof value === 'number' ? value : Number(value);
	if (!Number.isInteger(frames)) return null;
	if (frames < MIN_MANUAL_DELAY || frames > MAX_INPUT_DELAY) return null;
	return frames;
}

/** The stored choice for this game, defaulting to the automatic loop. */
export function readLatencyPreference(storage: PreferenceStorage, gameId: string): LatencyMode {
	if (!gameId) return 'auto';
	const stored = storage.getItem(keyFor(gameId));
	if (!stored) return 'auto';

	const mode = parseLatencyMode(stored);
	if (mode === null) {
		// A value this build does not understand is removed rather than kept: it
		// would otherwise sit in the profile for ever, silently meaning 'auto'
		// while looking to the reader like a setting that had been chosen.
		storage.removeItem(keyFor(gameId));
		return 'auto';
	}
	return mode;
}

/** Stores the choice for this game. Writing the default clears the entry. */
export function writeLatencyPreference(
	storage: PreferenceStorage,
	gameId: string,
	mode: LatencyMode
): void {
	if (!gameId) return;
	if (mode === 'auto') storage.removeItem(keyFor(gameId));
	else storage.setItem(keyFor(gameId), String(mode));
}
