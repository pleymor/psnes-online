import type { SaveOwnership } from '../db/saves.js';

/**
 * Whether this user may delete this save, through this game.
 *
 * Both halves, and the second one is the half that is easy to forget. Asking
 * only "is this game mine?" leaves the route open to
 * `DELETE /api/games/<a game I own>/saves/<a save of someone else's game>`,
 * which a guard reading the URL's game id happily allows. Asking only "is this
 * save mine?" is safe but makes the nested route a lie - the parent in the path
 * would mean nothing.
 *
 * A pure function rather than an `if` in the handler because nothing in this
 * repository can drive an Express route in a test, so a guard written inline
 * there is a guard nobody can prove.
 */
export function canDeleteSave(
  ownership: SaveOwnership | null,
  userId: string,
  gameId: string
): boolean {
  if (!ownership) return false;
  return ownership.ownerId === userId && ownership.gameId === gameId;
}
