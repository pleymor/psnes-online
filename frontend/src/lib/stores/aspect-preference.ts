/**
 * The stored picture shape.
 *
 * `aspect` was the one display setting with no lifetime at all: the pause menu
 * toggled it, the room used it, and a reload put it back to square pixels. That
 * was tolerable while nothing else read it, and stops being tolerable the
 * moment a player is offered a file holding "my configuration" - exporting a
 * setting that does not survive a reload exports nothing.
 *
 * Takes its storage rather than reaching for `localStorage`, the same shape as
 * the shader and latency preferences either side of it.
 */

import type { PixelAspect } from '$lib/znet/fit';
import type { PreferenceStorage } from './shader-preference';

const KEY = 'psnes-aspect';

/** The default, and what an unreadable value falls back to. */
export const DEFAULT_ASPECT: PixelAspect = 'square';

/** A picture shape out of anything, or null when it is not one. */
export function parseAspect(value: unknown): PixelAspect | null {
	return value === 'square' || value === 'crt' ? value : null;
}

/**
 * The stored shape, defaulting to square pixels.
 *
 * A value this build does not understand is removed rather than kept: it would
 * otherwise sit in the profile for ever, silently meaning 'square' while
 * looking to a reader like a choice that had been made.
 */
export function readAspectPreference(storage: PreferenceStorage): PixelAspect {
	const stored = storage.getItem(KEY);
	if (!stored) return DEFAULT_ASPECT;

	const aspect = parseAspect(stored);
	if (aspect === null) {
		storage.removeItem(KEY);
		return DEFAULT_ASPECT;
	}
	return aspect;
}

/** Stores the shape. Writing the default clears the entry. */
export function writeAspectPreference(storage: PreferenceStorage, aspect: PixelAspect): void {
	if (parseAspect(aspect) === null) return;
	if (aspect === DEFAULT_ASPECT) storage.removeItem(KEY);
	else storage.setItem(KEY, aspect);
}
