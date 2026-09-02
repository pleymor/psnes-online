/**
 * The two bits of state the top bar and the shell share.
 *
 * The button lives in `TopBar` and the scene lives in `VrShell`, mounted in the
 * layout - they cannot call each other, so they meet here. The same shape as
 * `rooms/room-intent.ts`: a store and a verb, no logic.
 *
 * `vrActive` is read by more than the shell: `+layout.svelte`'s `room:opened`
 * handler consults it before navigating, because a `goto` under an immersive
 * session would mount a second emulator behind it.
 */

import { writable } from 'svelte/store';

/** Set by the button, cleared by the shell once it has acted. */
export const vrRequested = writable(false);

/** True from `requestSession` resolving until `sessionend`. */
export const vrActive = writable(false);

export function requestVr(): void {
  vrRequested.set(true);
}
