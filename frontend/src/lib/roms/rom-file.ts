/**
 * Guards a single file picked through `<input type="file">` before it is
 * checksummed and registered.
 *
 * This is the only real check on a file the user supplies - the kind that
 * rots silently, because nothing fails visibly when an extension or a size
 * cap stops being enforced. Extracted so a test can prove it still rejects
 * what it always rejected.
 */

/** The `accept` attribute value for a file input picking a single ROM. */
export const ACCEPT = '.smc,.sfc,.fig,.swc,.mgd,.zip';
const MAX_BYTES = 8 * 1024 * 1024;

/** Returns the translation key for the problem with this file, or `null` if it is acceptable. */
export function romFileProblem(name: string, size: number): 'romInvalidType' | 'romTooLarge' | null {
	const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
	if (!ACCEPT.split(',').includes(ext)) return 'romInvalidType';
	if (size > MAX_BYTES) return 'romTooLarge';
	return null;
}

/**
 * A filename for a game that arrived over the socket and has none.
 *
 * The bytes come from a transfer, so the only name available is the room's
 * title - which came from the catalogue, or from whatever another player
 * typed. It ends up as the argument to `getFileHandle` inside a folder the
 * player has entrusted to us, so anything path-shaped has to go before it
 * gets there. `getFileHandle` refuses separators itself, but leaving the rule
 * to a browser API means it is not stated anywhere we can read or test.
 *
 * `.sfc` because that is what the bytes are: a headerless SNES dump is what
 * `normaliseRom` produces and what every emulator here expects.
 */
export function romFileName(title: string, checksum: string): string {
	const cleaned = title
		// Separators and the characters Windows refuses, to one space each.
		.replace(/[/\\:*?"<>|]+/g, ' ')
		// A leading dot would hide the file, and a run of them is path-shaped.
		.replace(/\.+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		// Long enough for any real title, short enough for every filesystem.
		.slice(0, 96)
		.trim();

	return `${cleaned || checksum}.sfc`;
}
