import { writable } from 'svelte/store';

/**
 * The player asked to play without an account, from the sign-in page's link.
 *
 * Kept for the tab's session, not forever: a reload of the game page must not
 * send them back to the sign-in screen mid-evening, but tomorrow's visit
 * starts at the ordinary front door. Offline, the switch does not depend on
 * this at all - `linkState` going 'unreachable' is enough, see
 * `rooms/local-play.ts`.
 */
const KEY = 'psnes.playLocally';

function read(): boolean {
	try {
		return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(KEY) === '1';
	} catch {
		return false;
	}
}

export const playLocally = writable<boolean>(read());

playLocally.subscribe((value) => {
	try {
		if (typeof sessionStorage === 'undefined') return;
		if (value) sessionStorage.setItem(KEY, '1');
		else sessionStorage.removeItem(KEY);
	} catch {
		// Private browsing with storage blocked: the choice lasts until reload.
	}
});
