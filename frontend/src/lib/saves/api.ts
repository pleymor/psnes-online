/**
 * Reading a game's saves, with the failure kept visible.
 *
 * Both save menus need this list, and neither may treat "could not ask" as
 * "there are none". An earlier version of the load path acted on `res.ok` and
 * did nothing otherwise, so an expired session produced an empty list, no
 * error, and a save that overwrote an existing one because the form thought
 * slot 1 was free. The result type is a discriminated union precisely so that
 * a caller cannot skip the failure case by accident.
 */

export interface SaveSummary {
  id: string;
  name: string;
  slotNumber: number;
  screenshot: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The translation key describing why the list could not be read. */
export type LoadFailure = 'sessionExpired' | 'notYourGame' | 'failedToLoadSaves';

export type SavesResult =
  | { ok: true; saves: SaveSummary[] }
  | { ok: false; reason: LoadFailure };

/**
 * Which failure a status code means.
 *
 * 401 and 403 are different problems with different remedies: one is "sign in
 * again", the other is "this is not your game". Telling someone to sign in
 * again when their session is perfectly fine sends them round a loop.
 */
export function loadFailureReason(status: number): LoadFailure {
  if (status === 401) return 'sessionExpired';
  if (status === 403) return 'notYourGame';
  return 'failedToLoadSaves';
}

export async function fetchSaves(gameId: string): Promise<SavesResult> {
  try {
    const res = await fetch(`/api/games/${gameId}/saves`, { credentials: 'include' });
    if (!res.ok) return { ok: false, reason: loadFailureReason(res.status) };
    return { ok: true, saves: await res.json() };
  } catch {
    return { ok: false, reason: 'failedToLoadSaves' };
  }
}

/** Newest first, which is the order both menus want. */
export function byNewest(saves: SaveSummary[]): SaveSummary[] {
  return [...saves].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The name a new save gets, since the player no longer types one.
 *
 * Date and time, in the player's own locale - the thumbnail does the work of
 * saying which moment it is, so the name only has to disambiguate.
 */
export function autoSaveName(locale: string, now: Date = new Date()): string {
  return now.toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}
