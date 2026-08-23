import type { CommunityEntryInput } from '../db/game-metadata.js';

/** Long enough for any real title or publisher, short enough to bound a row. */
export const MAX_FIELD = 200;

/** A description is prose; the rest are labels. */
export const MAX_DESCRIPTION = 2000;

/**
 * Turns whatever arrived in the body into a row that cannot be malformed.
 *
 * Every field being optional is the feature -- a player fills in what they
 * know -- so this normalises rather than refuses: a blank becomes null (an
 * empty string would read as a present-but-blank value in every UI that tests
 * truthiness), a non-string is dropped rather than coerced, and the keys are
 * enumerated so nothing else in the body can reach a column. The title falls
 * back to the game's current name, because that column is NOT NULL and "all
 * optional" must not mean "a row with no title".
 */
export function sanitiseEntry(raw: unknown, fallbackTitle: string): CommunityEntryInput {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const field = (key: string, max = MAX_FIELD): string | null => {
    const value = body[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed.slice(0, max);
  };

  return {
    title: field('title') ?? fallbackTitle.slice(0, MAX_FIELD),
    altTitle: field('altTitle'),
    genre: field('genre'),
    publisher: field('publisher'),
    developer: field('developer'),
    releaseDate: field('releaseDate'),
    players: field('players'),
    region: field('region'),
    description: field('description', MAX_DESCRIPTION)
  };
}
