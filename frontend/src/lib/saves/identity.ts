import { autoSaveName, type SaveSummary } from './api';
import { QUICK_SAVE_NAME } from './quick';

/** The one or two lines a tile shows for a save. */
export interface SaveIdentity {
	primary: string;
	/** Absent when the primary line already is the moment. */
	secondary?: string;
}

/** The date as a tile shows it: short, and without the seconds nobody reads. */
export function formatSaveDate(iso: string, locale: string): string {
	return new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Whether this name was generated rather than chosen.
 *
 * Compared against `createdAt`, never `updatedAt`: overwriting a save keeps the
 * name it was born with and moves `updatedAt`, so matching on the latter would
 * call every overwritten save "renamed" and put the timestamp back on two
 * lines - which is the whole problem this module exists to remove.
 */
function isAutoNamed(save: SaveSummary, locale: string): boolean {
	return save.name === autoSaveName(locale, new Date(save.createdAt));
}

/**
 * What the tile says, in one line where one line is enough.
 *
 * `autoSaveName` builds a name out of the date and nothing can rename a save
 * afterwards, so for every save this app has ever written the name and the
 * date underneath are the same fact. Printing both is what left twenty pixels
 * for each in a 20rem panel.
 *
 * The moment shown is always `updatedAt`, because that is when the state in the
 * file was captured; the name only decides whether it has anything else to add.
 *
 * `autoSaveName` is locale-dependent, so a save written in one language and
 * read in another will not match and falls back to two lines. Degraded rather
 * than wrong: the tile stays truthful and merely spends a line it did not need.
 */
export function saveIdentity(
	save: SaveSummary,
	locale: string,
	quickSaveLabel?: string
): SaveIdentity {
	/*
	 * The quick save is stored under a sentinel nobody would type, so that
	 * changing language cannot orphan it and start a second one. The label is
	 * passed in rather than translated here: this module is unit-tested from
	 * plain node, which cannot resolve the alias the translations live behind.
	 */
	if (quickSaveLabel && save.name === QUICK_SAVE_NAME) {
		return { primary: quickSaveLabel, secondary: formatSaveDate(save.updatedAt, locale) };
	}

	if (isAutoNamed(save, locale)) {
		return { primary: formatSaveDate(save.updatedAt, locale) };
	}

	return { primary: save.name, secondary: formatSaveDate(save.updatedAt, locale) };
}
