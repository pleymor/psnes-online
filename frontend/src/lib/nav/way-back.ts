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

/**
 * Screens where going home is plain navigation and nothing else.
 *
 * `/docs` joined the day the brand was removed from the bar. The comment
 * above says the brand was the way home that nobody announced; with it gone,
 * a reader of the documentation had no way back at all - not a convention
 * that failed to read as one, simply nothing. The room still gets none, for
 * the reason spelled out above: leaving one is an action that page owns, and
 * it offers its own button for it.
 */
const PLAIN_NAVIGATION = new Set(['/profile', '/docs']);

/**
 * Les écrans dont le chemin porte un paramètre.
 *
 * `PLAIN_NAVIGATION` compare des chemins exacts, ce qui suffisait tant que tous
 * les écrans concernés étaient fixes. Le classement est `/classement/<crc32>` :
 * il lui faut un préfixe, et un préfixe comparé sur les SEGMENTS - un
 * `startsWith('/classement')` nu accepterait `/classements`, une route qui
 * n'existe pas aujourd'hui et qui existera peut-être demain.
 */
const PLAIN_NAVIGATION_PREFIXES = ['/classement'];

/** `/profile/` and `/profile` are the same screen; `/` stays `/`. */
function normalise(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
	return pathname;
}

export function wayBack(pathname: string): WayBack | null {
	const path = normalise(pathname ?? '');
	const plain =
		PLAIN_NAVIGATION.has(path) ||
		PLAIN_NAVIGATION_PREFIXES.some((prefix) => path.startsWith(`${prefix}/`));
	if (!plain) return null;
	return { href: '/', label: 'backToLibrary' };
}
