/**
 * Finding the catalogue entry a player means.
 *
 * Pure, and reading the catalogue from an argument rather than the database:
 * the caller passes the in-memory cache, so a search costs no query, and the
 * ranking can be tested for the thing that actually matters -- that the entry
 * the player means comes back first.
 */

import { normalizeTitle } from './metadata-loader.js';
import type { GameMetadata, MetadataSource } from '../db/types.js';

/** Enough to tell two dumps of the same game apart, and nothing more. */
export interface CatalogueMatch {
  id: string;
  title: string;
  altTitle: string | null;
  region: string | null;
  publisher: string | null;
  releaseDate: string | null;
  coverUrl: string | null;
  source: MetadataSource;
}

export const SEARCH_LIMIT = 20;

/** Below this, a query matches most of the catalogue and orders it arbitrarily. */
const MIN_QUERY = 2;

/** Lower is better; null means no match at all. */
function score(candidate: string, query: string): number | null {
  if (!candidate) return null;
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;
  if (candidate.includes(query)) return 2;
  return null;
}

function best(entry: GameMetadata, query: string): number | null {
  const scores = [
    score(normalizeTitle(entry.title), query),
    entry.altTitle ? score(normalizeTitle(entry.altTitle), query) : null
  ].filter((s): s is number => s !== null);
  return scores.length > 0 ? Math.min(...scores) : null;
}

function toMatch(entry: GameMetadata): CatalogueMatch {
  return {
    id: entry.id,
    title: entry.title,
    altTitle: entry.altTitle,
    region: entry.region,
    publisher: entry.publisher,
    releaseDate: entry.releaseDate,
    coverUrl: entry.coverUrl,
    source: entry.source
  };
}

export function rankCatalogue(entries: GameMetadata[], query: string): CatalogueMatch[] {
  const normalised = normalizeTitle(query);
  if (normalised.length < MIN_QUERY) return [];

  const scored: { entry: GameMetadata; rank: number }[] = [];
  for (const entry of entries) {
    const rank = best(entry, normalised);
    if (rank !== null) scored.push({ entry, rank });
  }

  // Alphabetical within a rank, so the order is stable rather than whatever
  // the table happened to return.
  scored.sort((a, b) => a.rank - b.rank || a.entry.title.localeCompare(b.entry.title));

  return scored.slice(0, SEARCH_LIMIT).map(s => toMatch(s.entry));
}
