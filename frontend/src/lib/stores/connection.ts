import { writable } from 'svelte/store';

/**
 * Whether the app has a live socket.
 *
 * Two states, not three: the client now retries for as long as the tab is
 * open, so there is no "gave up" to represent. Starts 'connected' so the
 * banner does not flash during the very first connect, which is not a
 * reconnection and is not worth telling anyone about.
 */
export type LinkState = 'connected' | 'reconnecting';

export const linkState = writable<LinkState>('connected');
