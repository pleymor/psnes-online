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
  /**
   * Ce joueur est entré par un lien de salon, sans compte.
   *
   * Il n'a ni bibliothèque, ni amis, ni profil, ni sauvegardes : le serveur
   * refuse toutes ces routes en 403, et `rooms/anonymous-join.ts` dit lesquelles
   * pour que l'interface ne propose pas de boutons qui échouent.
   *
   * Distinct de `needsPseudo`, qui vaut faux pour lui : son `pseudoChosenAt`
   * est null comme celui d'un compte neuf, mais il n'a pas de compte à
   * embarquer et la route pour en sortir lui est fermée.
   */
  isAnonymous: boolean;
}

export const user = writable<User | null>(null);
export const userLoading = writable<boolean>(true);
