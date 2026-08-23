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

import type { PreferenceStorage } from './shader-preference';

/**
 * `auto` lets the strain loop size the delay, protecting whichever player is
 * losing frames. `low` pins it at LOW_DELAY_FRAMES, which is latency first and
 * the partner's smoothness second.
 */
export type LatencyMode = 'auto' | 'low';

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

const MODES: LatencyMode[] = ['auto', 'low'];

function keyFor(gameId: string): string {
	return `${PREFIX}${gameId}`;
}

/** The stored choice for this game, defaulting to the automatic loop. */
export function readLatencyPreference(storage: PreferenceStorage, gameId: string): LatencyMode {
	if (!gameId) return 'auto';
	const stored = storage.getItem(keyFor(gameId));
	if (!stored) return 'auto';
	if (!MODES.includes(stored as LatencyMode)) {
		// A value this build does not understand is removed rather than kept: it
		// would otherwise sit in the profile for ever, silently meaning 'auto'
		// while looking to the reader like a setting that had been chosen.
		storage.removeItem(keyFor(gameId));
		return 'auto';
	}
	return stored as LatencyMode;
}

/** Stores the choice for this game. Writing the default clears the entry. */
export function writeLatencyPreference(
	storage: PreferenceStorage,
	gameId: string,
	mode: LatencyMode
): void {
	if (!gameId) return;
	if (mode === 'auto') storage.removeItem(keyFor(gameId));
	else storage.setItem(keyFor(gameId), mode);
}
