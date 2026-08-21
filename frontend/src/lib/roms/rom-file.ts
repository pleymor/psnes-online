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
