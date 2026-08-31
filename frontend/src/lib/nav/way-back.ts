/**
 * The labelled way back the top bar offers, per screen.
 *
 * The bar has always carried a way home: the `🎮 PSNES` brand links to `/`.
 * That is a convention the web honours and nobody announces, and on /profile it
 * was the only way back - so the affordance existed and did not read as one.
 * The bar now carries a labelled link as well, and this is the rule for where.
 *
 * It is an allowlist, not "everywhere except the library", and the room screen
 * is why. Leaving a room is an action that page owns: `releaseGame` detaches the
 * game, gives up a seat nobody else holds and forgets the remembered room before
 * it navigates. A bare `<a href="/">` in the bar would do none of that and would
 * walk the player back to the library still seated in a room the server thinks
 * they are in. A way back that lies is worse than no way back, so a screen gets
 * one only once somebody has decided plain navigation is right for it.
 */

/** The label key, resolved by the caller through `t()`. */
export type WayBack = { href: string; label: 'backToLibrary' };

/** Screens where going home is plain navigation and nothing else. */
const PLAIN_NAVIGATION = new Set(['/profile']);

/** `/profile/` and `/profile` are the same screen; `/` stays `/`. */
function normalise(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
	return pathname;
}

export function wayBack(pathname: string): WayBack | null {
	if (!PLAIN_NAVIGATION.has(normalise(pathname ?? ''))) return null;
	return { href: '/', label: 'backToLibrary' };
}
