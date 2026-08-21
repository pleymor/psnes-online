/**
 * Which form the profile page's ROM panel takes.
 *
 * A pure function over facts already gathered, deliberately: the gathering
 * needs `showDirectoryPicker`, IndexedDB and a permission prompt, none of which
 * exist under Node - and this decision is the one in that panel that can be
 * wrong without anyone seeing it. Getting `unsupported` wrong leaves Firefox
 * and Safari with an empty library and no way to add anything.
 */

export interface RomSourceFacts {
	/** Whether this browser can remember a folder at all. */
	supported: boolean;
	/** The remembered folder's name, if there is one. */
	folderName?: string;
	/** Whether the browser still grants access to it. */
	accessGranted?: boolean;
}

export type RomSourceState =
	| { kind: 'folder'; name: string }
	| { kind: 'folder-stale'; name: string }
	| { kind: 'no-folder' }
	| { kind: 'unsupported' };

export function romSourceState(facts: RomSourceFacts): RomSourceState {
	// The API decides first. A folder name left by another browser, or by a
	// shared profile, must not make an unsupported browser look capable.
	if (!facts.supported) return { kind: 'unsupported' };

	if (!facts.folderName) return { kind: 'no-folder' };

	// Absence of a granted flag is not a grant. Permission on a stored folder
	// lapses between sessions and re-granting needs a gesture, so this is a
	// state the player can act on - and a different action from picking a
	// folder they already picked.
	return facts.accessGranted
		? { kind: 'folder', name: facts.folderName }
		: { kind: 'folder-stale', name: facts.folderName };
}
