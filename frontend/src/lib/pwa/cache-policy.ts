/**
 * What the service worker may keep, and what it must never touch.
 *
 * Pure functions, because the worker itself cannot be exercised outside a
 * browser and these are the decisions that leak data or break the offline
 * mode when they are wrong. No `$lib` import: `core/test` runs under bare node.
 */

/** The page every navigation falls back on offline: the prerendered app shell. */
export const SHELL = '/';

/**
 * Paths whose answers belong to a session, or to nobody at all.
 *
 * `/api` is a player's library, friends and saves; `/auth` is who they are;
 * `/socket.io` is the live link. Served from a cache after a logout, the first
 * two would hand one player's data to the next person on the same browser.
 */
const NETWORK_ONLY = ['/api', '/auth', '/socket.io'];

function underAny(pathname: string, prefixes: readonly string[]): boolean {
	return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Whether a request must go to the network untouched: never read from nor written to the cache. */
export function networkOnly(url: URL, origin: string): boolean {
	return url.origin === origin && underAny(url.pathname, NETWORK_ONLY);
}

/**
 * Whether a response fetched at run time may be stored.
 *
 * A 200 only: an error page cached under an asset's URL would be served in
 * its place for the life of the deployment. `basic` or `cors` only: an opaque
 * response hides its status, so a cached one could be a failure. And never one
 * that says it is private or not to be stored - that is the server saying,
 * about this very answer, what `networkOnly` says about whole paths.
 */
export function cacheableResponse(response: {
	status: number;
	type: string;
	headers: { get(name: string): string | null };
}): boolean {
	if (response.status !== 200) return false;
	if (response.type !== 'basic' && response.type !== 'cors') return false;
	const control = (response.headers.get('cache-control') ?? '').toLowerCase();
	return !/\b(no-store|private)\b/.test(control);
}

/** Whether a failed request should be answered with the app shell. */
export function shellFallback(mode: string, url: URL, origin: string): boolean {
	return mode === 'navigate' && url.origin === origin && !networkOnly(url, origin);
}
