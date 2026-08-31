/**
 * What a room says when a game decides someone lost.
 *
 * The verdict itself is a display detail, and deliberately so: nothing in the
 * schema records a match result, and inventing a table for the first game whose
 * memory layout has been read would be a migration paid for one row of
 * addresses. A toast and a running score for as long as the room is open is the
 * whole of it, and it costs a store nothing.
 *
 * Separate from the components because the two rooms that can do this - solo
 * and lockstep - would otherwise say it twice, in two wordings that drift.
 */

import { t } from '$lib/i18n/translations';
import type { MatchVerdict } from '$lib/games/match-watch';

/**
 * A line naming the winner and the score so far.
 *
 * Ports rather than nicknames. The game knows which controller was left
 * standing; who is holding it is the room's business, and in solo with a second
 * pad plugged in it is the same person twice.
 */
export function verdictMessage(
	lang: 'en' | 'fr',
	verdict: MatchVerdict,
	score: readonly [number, number]
): string {
	const who =
		verdict.winner === 0
			? t(lang, 'matchDrawn')
			: t(lang, 'matchWonBy', { player: verdict.winner });
	return `${who} - ${t(lang, 'matchScore', { p1: score[0], p2: score[1] })}`;
}
