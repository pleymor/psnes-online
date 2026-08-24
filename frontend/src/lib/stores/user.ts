import { writable } from 'svelte/store';

/**
 * What /auth/me tells us about the signed-in player, and nothing more.
 *
 * googleId and email are gone: the first never leaves the server now, the
 * second no longer exists. Keep this in step with toSelf() in
 * backend/src/api/auth.ts, which is the shape actually on the wire.
 */
export interface User {
  id: string;
  pseudo: string;
  /** Four digits. Together with `pseudo` this is the code a player shares. */
  discriminator: string;
  avatar?: string;
  /**
   * True while the pseudonym the player carries was assigned rather than
   * chosen. It is what raises the blocking modal, and what holds the socket
   * back - the server refuses both anyway, this only avoids asking.
   */
  needsPseudo: boolean;
}

export const user = writable<User | null>(null);
export const userLoading = writable<boolean>(true);
