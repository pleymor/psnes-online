/**
 * What a warming pass should do with one catalogue row.
 *
 * Pure, so the loop in covers-cli.ts is a loop and nothing else, and so the
 * rules that matter -- an upload outranks a catalogue URL, a refreshed
 * catalogue does not undo the ingestion -- can be read in one place.
 */

export interface CoverRowState {
  /** Where the bytes come from. `syncCatalogue` rewrites this from the shipped file. */
  coverUrl: string | null;
  /** What we serve, once ingested. Ours; the catalogue file never touches it. */
  servedCoverUrl: string | null;
  /** A cover this player uploaded, living as a BLOB on the row. */
  hasCover: boolean;
}

export type CoverTask =
  | { do: 'skip' }
  | { do: 'fetch'; url: string }
  | { do: 'upload' }
  | { do: 'nothing' };

function isFetchable(url: string | null): url is string {
  return url !== null && (url.startsWith('https://') || url.startsWith('http://'));
}

export function coverTaskFor(state: CoverRowState, opts: { rebuild: boolean }): CoverTask {
  if (state.servedCoverUrl && !opts.rebuild) return { do: 'skip' };

  // The BLOB first: a player who went and found a better scan meant it, and it
  // is the one image here that cannot be fetched again from anywhere.
  if (state.hasCover) return { do: 'upload' };

  if (isFetchable(state.coverUrl)) return { do: 'fetch', url: state.coverUrl };

  return { do: 'nothing' };
}
