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
 * Les jaquettes : le seul contenu de run-time que le worker garde d'un
 * déploiement à l'autre (#71 §7.4).
 *
 * Un cache à part, qui n'est pas nommé d'après le build : le cache versionné
 * est effacé à chaque déploiement, et une bibliothèque hors-ligne qui perd ses
 * images chaque fois qu'on livre serait la régression que le ticket décrit.
 * `v1` ne change que si la forme de ce qui y est rangé change.
 */
export const COVERS_CACHE = 'psnes-covers-v1';

/**
 * Les chemins de jaquettes, tous publics.
 *
 * `/covers/<empreinte>.webp` est servi par nginx depuis un volume, sans
 * session. `/api/covers/<id>` est la seule exception sous `/api`, et une
 * exception écrite : la route est publique exprès (`backend/src/api/covers.ts`)
 * et répond `public, immutable`. Rien d'autre sous `/api` n'y entre - ni la
 * bibliothèque, ni les sauvegardes, ni le profil.
 */
const COVER_PATHS = ['/covers', '/api/covers'];

/** Whether a request is for a cover the worker may keep and serve stale-while-revalidate. */
export function coverRequest(url: URL, origin: string): boolean {
	return url.origin === origin && underAny(url.pathname, COVER_PATHS);
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
