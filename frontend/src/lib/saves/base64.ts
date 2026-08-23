/**
 * Base64 for buffers of any size.
 *
 * `String.fromCharCode(...bytes)` spreads one argument per byte, which blows
 * the call stack somewhere around 100k. A real savestate is over 800KB.
 *
 * Its own module, with no imports at all, so that `core/test` can reach it:
 * everything else in the capture path pulls in the logger, which pulls in a
 * `$lib` alias that plain node cannot resolve. That is the whole reason this
 * one line of behaviour - the one with a documented stack-overflow bug behind
 * it - had never been tested.
 */
export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
