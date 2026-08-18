import { writable } from 'svelte/store';

/**
 * Whether the app has a live socket.
 *
 * Three states, not two: socket.io keeps retrying after a network drop, but
 * it never retries after an explicit disconnect from either end - a
 * deliberate logout ('io client disconnect') or a server-initiated kick
 * ('io server disconnect'). Those need their own state, because there waiting
 * is futile and telling the player "reconnecting…" would be a lie. Starts
 * 'connected' so the banner does not flash during the very first connect,
 * which is not a reconnection and is not worth telling anyone about.
 */
export type LinkState = 'connected' | 'reconnecting' | 'offline';

export const linkState = writable<LinkState>('connected');
