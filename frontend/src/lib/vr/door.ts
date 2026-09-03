/**
 * The folder permission, asked for at the door instead of at the point of use.
 *
 * A stored directory handle loses its read permission between browser
 * sessions, and re-granting it needs a native dialog. That dialog cannot
 * render inside an immersive session - it is drawn by the browser, on the
 * page, which is exactly what a headset has replaced. So `resolveQuietly` is
 * told never to ask from in there (`roms/provider.ts`), and the library panel
 * shows a notice instead. That stopped the player being thrown out of the
 * headset mid-launch, and left them with nothing they could do about it: the
 * notice was true and the game stayed unreachable.
 *
 * The press on "Enter VR" is the answer. It happens on the flat page, where a
 * dialog renders normally, and it is a real user gesture - so it can buy a
 * permission that then lasts the whole session, including the first launch.
 * The rule is simply that the gesture is spent where the dialog can be seen.
 *
 * Everything the browser provides arrives as a port, for the reason the rest
 * of this codebase's device code gives: so the decision is testable without
 * IndexedDB, without a file system and without a headset.
 */

export interface DoorPorts {
	supportsDirectoryPicker(): boolean;
	storedDirectory(): Promise<FileSystemDirectoryHandle | undefined>;
	hasAccess(handle: FileSystemDirectoryHandle): Promise<boolean>;
	ensureAccess(handle: FileSystemDirectoryHandle): Promise<boolean>;
}

/**
 * Whether the next press has to buy a permission before it can open a session.
 *
 * Answered ahead of the press, never during it. `requestSession` needs the
 * transient activation the click carries, and awaiting even a fast IndexedDB
 * read spends part of a window measured in seconds - so the common path, where
 * nothing needs granting, stays synchronous from click to session.
 *
 * False on any failure, and that is the safe direction: a device with no
 * picker keeps its games in IndexedDB, which needs no permission at all, and a
 * check that throws must not be what stops somebody entering VR. The worst a
 * wrong `false` costs is the notice on the library panel, which is where this
 * whole story started and is survivable. A wrong `true` would block the door.
 */
export async function folderNeedsGrant(ports: DoorPorts): Promise<boolean> {
	try {
		if (!ports.supportsDirectoryPicker()) return false;
		const handle = await ports.storedDirectory();
		if (!handle) return false;
		return !(await ports.hasAccess(handle));
	} catch {
		return false;
	}
}

/**
 * What a press spent on the folder achieved.
 *
 * `entered` means no dialog was shown - the permission was already there, so
 * the caller should go straight into VR and the player never learns a check
 * happened. It exists because `folderNeedsGrant` is answered on mount and the
 * world moves: the flat page may have re-granted the folder in between, and
 * charging a second press for a dialog nobody saw would be a bug the player
 * could not explain.
 */
export type GrantOutcome = 'entered' | 'granted' | 'refused';

/** Spends the caller's gesture on the stored folder. */
export async function grantFolder(ports: DoorPorts): Promise<GrantOutcome> {
	try {
		const handle = await ports.storedDirectory();
		// No folder to grant is not a refusal: there is nothing here to stop.
		if (!handle) return 'entered';
		if (await ports.hasAccess(handle)) return 'entered';
		return (await ports.ensureAccess(handle)) ? 'granted' : 'refused';
	} catch {
		// Same direction as above: a broken check never bars the door.
		return 'entered';
	}
}
