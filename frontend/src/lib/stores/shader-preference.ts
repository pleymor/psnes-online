/**
 * The one place that reads and writes the stored shader choice.
 *
 * Four call sites hand-rolled this - the home page, both netplay rooms and the
 * solo room - and one of them had forgotten to purge a value that is no longer
 * a valid shader, which cost it a CDN round trip and a user-facing notice for
 * a preset that had been delisted. One function, one test, four callers.
 *
 * Takes its storage rather than reaching for `localStorage`, so it can be
 * tested without a browser.
 */

import { VALID_SHADER_IDS } from '../shaders';

const KEY = 'psnes-shader';

export interface PreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/**
 * The stored shader id, or '' for none.
 *
 * An id no longer in the offered list is removed rather than returned:
 * `xbrz-freescale` was delisted after its viewport scaling produced framebuffer
 * errors, and a profile that still holds it would keep paying for it.
 */
export function readShaderPreference(storage: PreferenceStorage): string {
	const stored = storage.getItem(KEY) || '';
	if (!stored) return '';
	if (!VALID_SHADER_IDS.includes(stored)) {
		storage.removeItem(KEY);
		return '';
	}
	return stored;
}

/**
 * Stores a shader id, or removes the key for ''.
 *
 * Removing rather than storing an empty string means no reader has to treat ''
 * and absent as the same thing - which is exactly the sort of equivalence one
 * of four readers eventually forgets.
 */
export function writeShaderPreference(storage: PreferenceStorage, id: string): void {
	if (!id) {
		storage.removeItem(KEY);
		return;
	}
	// A value no reader would accept is worse than no value: it would be purged
	// on the next read anyway, after costing a round trip.
	if (!VALID_SHADER_IDS.includes(id)) return;
	storage.setItem(KEY, id);
}
