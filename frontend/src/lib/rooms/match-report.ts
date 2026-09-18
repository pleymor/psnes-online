/**
 * What a room says when a game decides someone lost.
 *
 * This is the wording only. The schema does record match results now - see
 * `db/matches.ts` and migration 0008 - and the toast is one of two things a
 * verdict feeds, the other being the report that lands in that table. What
 * stays true is that the score shown here lives and dies with the room: the
 * standing a player carries between rooms is their rating, not this count.
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
