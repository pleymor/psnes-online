import { writable } from 'svelte/store';

/**
 * Whether an emulator is on screen right now.
 *
 * Set by the room page, read by the invitation card. It exists so the card can
 * stay out of the way of a running game: a panel over an emulator steals a
 * click, and accepting an invitation mid-game means walking out of the match
 * being played.
 *
 * Not derived from the route: the room page is also the lobby, and the lobby is
 * a perfectly good place to be told that somebody wants to play.
 */
export const inGame = writable(false);
