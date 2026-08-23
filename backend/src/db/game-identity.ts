/**
 * Deciding what a game is, from a row and a catalogue entry.
 *
 * Kept pure and kept apart from db/games.ts on purpose: this is the part that
 * can be wrong without anyone seeing it -- a merge rule that silently blanks a
 * field looks like a working library until someone notices their genres are
 * gone -- and db/games.ts is already 272 lines of row mapping in which a merge
 * rule would read as one more detail.
 */

import type { Game } from './types.js';

/** What a catalogue entry can say about a game. */
export interface IdentityFields {
  title: string | null;
  genre: string | null;
  publisher: string | null;
  developer: string | null;
  releaseDate: string | null;
  players: string | null;
  region: string | null;
  description: string | null;
  coverUrl: string | null;
}

/**
 * The columns a catalogue entry may fill in.
 *
 * The title is handled apart: it is NOT NULL on Game, so it needs a fallback
 * rather than an assignment.
 */
const DESCRIPTIVE = [
  'genre', 'publisher', 'developer', 'releaseDate',
  'players', 'region', 'description', 'coverUrl'
] as const;

/**
 * The game as it should be shown.
 *
 * The entry wins field by field wherever it has something, the row serving as
 * the fallback. The asymmetry is deliberate: a CRC32 link is exact evidence a
 * human posted, while a Game column holds whatever an approximate title match
 * produced. There is no risk of trampling a player's own wording -- the
 * application has no way to rename a game.
 */
export function mergeIdentity(game: Game, identity: IdentityFields | null): Game {
  if (!identity) return game;
  const merged: Game = { ...game, title: identity.title ?? game.title };
  for (const field of DESCRIPTIVE) {
    merged[field] = identity[field] ?? game[field];
  }
  return merged;
}

/**
 * Whether to ask the player who this is.
 *
 * A linked game never qualifies, however sparse its entry: somebody has
 * already answered the question. Absent a link, one known field is enough to
 * stay quiet -- the point is to catch the games nothing recognised, not to put
 * a badge on forty cards an approximate title match already filled in.
 */
export function needsIdentification(game: Game, identity: IdentityFields | null): boolean {
  if (identity) return false;
  return DESCRIPTIVE.every(field => game[field] === null);
}
