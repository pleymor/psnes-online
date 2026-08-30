/**
 * Carrying saves off this server, and handing one back.
 *
 * Portability, not backup: the point is the player who changes machine, or who
 * wants a copy of a hundred hours somewhere that is not this database. Since
 * the ROM lives on their own disk, their progress is the one thing that does
 * not.
 *
 * No `$lib` imports and no logger, on purpose - the same reason `base64.ts`
 * has none. `core/test` runs under plain node and cannot resolve SvelteKit's
 * alias, and the rules here (which failure means what, and which outcomes have
 * to be said out loud) are exactly the ones that must be provable.
 */

/* ---------------------------------------------------------------- the file */

export interface ExportOptions {
	/** One game rather than the library. The file shape is the same either way. */
	gameId?: string;
	/**
	 * Whether thumbnails travel. They do by default; `Save.screenshot` is a PNG
	 * data URL, so a full library is mostly picture by weight and a player on a
	 * slow line deserves the choice.
	 */
	screenshots?: boolean;
}

export function exportUrl(options: ExportOptions): string {
	const query = new URLSearchParams();
	if (options.gameId) query.set('gameId', options.gameId);
	if (options.screenshots === false) query.set('screenshots', '0');
	const suffix = query.toString();
	return suffix ? `/api/saves/export?${suffix}` : '/api/saves/export';
}

/** `psnes-saves-2026-08-30.json`: says what it is, and sorts by date. */
export function archiveFilename(now: Date = new Date()): string {
	return `psnes-saves-${now.toISOString().slice(0, 10)}.json`;
}

/* -------------------------------------------------------------- the upload */

/**
 * Why an import did not happen, as a translation key.
 *
 * Keys rather than sentences because the same discipline applies here as in
 * `api.ts`: a caller must not be able to skip the failure case by accident, and
 * a server-written string must never reach the screen.
 */
export type ImportFailureKey =
	| 'sessionExpired'
	| 'importNotAnArchive'
	| 'importNewerVersion'
	| 'importDamaged'
	| 'importTooLarge'
	| 'importFailed';

export type ArchiveTextResult =
	| { ok: true; archive: unknown }
	| { ok: false; reason: ImportFailureKey };

/**
 * A first look at the chosen file, before anything is uploaded.
 *
 * Deliberately shallow - it checks the envelope marker and nothing else. The
 * real validation is the server's, because the server is the only side that
 * has to be right about it, and duplicating a whitelist in two languages is
 * how the two stop agreeing. This exists so that picking the wrong file
 * entirely - a ROM, a screenshot, last week's tax return - is answered
 * instantly rather than after uploading fifty megabytes.
 */
export function parseArchiveText(text: string): ArchiveTextResult {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { ok: false, reason: 'importNotAnArchive' };
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { ok: false, reason: 'importNotAnArchive' };
	}
	if ((value as { format?: unknown }).format !== 'psnes-saves') {
		return { ok: false, reason: 'importNotAnArchive' };
	}
	return { ok: true, archive: value };
}

const REFUSALS: Record<string, ImportFailureKey> = {
	notAnArchive: 'importNotAnArchive',
	unsupportedVersion: 'importNewerVersion',
	malformed: 'importDamaged',
	tooLarge: 'importTooLarge'
};

/**
 * Which sentence a refusal deserves.
 *
 * Four reasons, four remedies: find the right file, update the app, the file
 * is damaged, the file is too big. Collapsing them into "import failed" sends
 * someone hunting for the wrong problem - and an unknown reason falls back
 * rather than rendering whatever string the server sent.
 */
export function importFailureKey(status: number, reason: string | undefined): ImportFailureKey {
	if (status === 401) return 'sessionExpired';
	if (reason && reason in REFUSALS) return REFUSALS[reason];
	return 'importFailed';
}

/* ------------------------------------------------------------- the outcome */

export interface ImportReport {
	gamesCreated: number;
	gamesMatched: number;
	gamesRefused: number;
	statesImported: number;
	duplicates: number;
	sramImported: number;
	sramKept: number;
}

export interface ImportResponse {
	/** False when the file was written by a different snes9x build. */
	coreMatches: boolean;
	report: ImportReport;
}

export interface SummaryLine {
	key: string;
	count: number;
}

/**
 * What to tell the player happened.
 *
 * Three of the seven counts are cases where the file held something and the
 * account did not gain it - savestates already present, a battery save kept
 * because there was one already, a game refused at the account ceiling. Those
 * lines are not optional: a summary showing only the cheerful counts would let
 * someone believe a save arrived, and then delete the file it was in.
 *
 * The core mismatch leads, when there is one. A savestate from a different
 * build does not fail on load, it loads into garbage, so those states were
 * dropped - and that is the one thing the player has to learn now rather than
 * from a corrupted save an hour later.
 */
export function importSummary(response: ImportResponse): SummaryLine[] {
	const { report } = response;
	const lines: SummaryLine[] = [];

	if (!response.coreMatches) lines.push({ key: 'importCoreMismatch', count: 0 });

	const counted: [string, number][] = [
		['importedGames', report.gamesCreated],
		['importedStates', report.statesImported],
		['importedSram', report.sramImported],
		['importSkippedDuplicates', report.duplicates],
		['importKeptSram', report.sramKept],
		['importRefusedGames', report.gamesRefused]
	];
	for (const [key, count] of counted) {
		if (count > 0) lines.push({ key, count });
	}

	if (lines.length === 0) lines.push({ key: 'importedNothing', count: 0 });
	return lines;
}

/* --------------------------------------------------------------- the calls */

export type ExportResult = { ok: true } | { ok: false; reason: ImportFailureKey };

/**
 * Downloads the archive and hands it to the browser as a file.
 *
 * A fetch and a blob rather than navigating to the URL: a navigation would
 * turn an expired session into a page of JSON error, or a blank tab, instead
 * of a sentence the player can act on.
 */
export async function downloadArchive(options: ExportOptions = {}): Promise<ExportResult> {
	try {
		const res = await fetch(exportUrl(options), { credentials: 'include' });
		if (!res.ok) {
			return { ok: false, reason: res.status === 401 ? 'sessionExpired' : 'importFailed' };
		}
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = archiveFilename();
		link.click();
		URL.revokeObjectURL(url);
		return { ok: true };
	} catch {
		return { ok: false, reason: 'importFailed' };
	}
}

export type ImportResult =
	| { ok: true; response: ImportResponse }
	| { ok: false; reason: ImportFailureKey };

export async function uploadArchive(
	archive: unknown,
	replaceSram: boolean
): Promise<ImportResult> {
	try {
		const res = await fetch('/api/saves/import', {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ archive, replaceSram })
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { reason?: string };
			return { ok: false, reason: importFailureKey(res.status, body.reason) };
		}
		return { ok: true, response: (await res.json()) as ImportResponse };
	} catch {
		return { ok: false, reason: 'importFailed' };
	}
}
