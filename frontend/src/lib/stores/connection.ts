import { get, writable } from 'svelte/store';

/**
 * Whether the app has a live socket.
 *
 * Four states, not two. socket.io keeps retrying after a network drop, but it
 * never retries after an explicit disconnect from either end - a deliberate
 * logout ('io client disconnect') or a server-initiated kick
 * ('io server disconnect'). Those need their own state, because there waiting
 * is futile and telling the player "reconnecting…" would be a lie.
 *
 * 'unreachable' is the fourth: the socket has never once connected. It is
 * distinct from 'reconnecting' because there is no connection to have lost, and
 * distinct from 'offline' because the server never answered - the block is
 * somewhere between the browser and it. The client forces the websocket
 * transport with no polling fallback, so anything that blocks the upgrade -
 * an extension, an HTTPS-scanning antivirus, a proxy - lands here and nowhere
 * else.
 *
 * Starts 'connected' so the banner does not flash during the very first
 * connect, which is not a reconnection and is not worth telling anyone about.
 * That default is exactly why 'unreachable' has to be set explicitly: a socket
 * that never connects raises `connect_error`, never `disconnect`, so without a
 * listener for it the store sat on 'connected' forever. Presence and
 * invitations live only on the socket, so they silently did nothing while the
 * app looked healthy - which reads as a broken friendship rather than a
 * blocked connection.
 */
export type LinkState = 'connected' | 'reconnecting' | 'offline' | 'unreachable';

export const linkState = writable<LinkState>('connected');

/** The subset of a socket.io client the link-state machine listens to. */
export interface LinkSocket {
	on(event: string, handler: (...args: any[]) => void): unknown;
}

/**
 * Drives `linkState` from one socket's lifecycle events.
 *
 * Separate from `initializeSocket` so the state machine is testable without a
 * server, a browser or socket.io itself.
 */
export function attachLinkState(socket: LinkSocket): void {
	// Per socket instance, not module-level: a logout tears the socket down and
	// the next login builds a fresh one, which starts having never connected.
	let everConnected = false;

	socket.on('connect', () => {
		everConnected = true;
		linkState.set('connected');
	});

	socket.on('disconnect', (reason: string) => {
		const isExplicitDisconnect =
			reason === 'io client disconnect' || reason === 'io server disconnect';
		linkState.set(isExplicitDisconnect ? 'offline' : 'reconnecting');
	});

	socket.on('connect_error', () => {
		// Guarded on `everConnected`, because socket.io raises this on every
		// failed retry too. After a drop mid-session the honest state is
		// 'reconnecting', already set by the disconnect above; overwriting it
		// would tell a player who was in a game a minute ago that the server had
		// never been reachable.
		if (!everConnected) linkState.set('unreachable');
	});
}

/**
 * The server did not answer the very first request, before any socket existed.
 *
 * Called by the layout when `/auth/me` fails at the network level. Without it
 * a visitor with no network never reaches 'unreachable' at all: the socket is
 * only opened once somebody is signed in, and nobody can sign in without the
 * server - so the one state that means "the server never answered" was the one
 * an offline visitor could not get into. It is what switches the home page to
 * solo play without an account (`rooms/local-play.ts`).
 *
 * Only from the untouched default. A socket that already connected or dropped
 * has said something about the server that this must not overwrite.
 */
export function noteServerSilent(): void {
	if (get(linkState) === 'connected') linkState.set('unreachable');
}

/**
 * Whether an HTTP answer means the server itself never answered.
 *
 * A thrown fetch is the plain case: no network, or a service worker with no
 * network behind it. 502, 503 and 504 are the proxy in front saying the same
 * thing about the backend behind it. Anything else is the server speaking.
 */
export function serverSilent(outcome: { threw: true } | { status: number }): boolean {
	if ('threw' in outcome) return true;
	return outcome.status === 502 || outcome.status === 503 || outcome.status === 504;
}
