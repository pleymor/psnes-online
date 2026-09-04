/**
 * Bringing the games into the device before the headset takes over.
 *
 * The empirical law this exists for, established on a real Quest 3 over a
 * whole afternoon of testing: **reading the folder from inside an immersive
 * session never works.** The permission granted on the flat page is real, and
 * `queryPermission` still answers "not granted" once the session is running -
 * cleanly, with no exception, which is why the panel reports `no-permission`.
 * Two fixes were built on the assumption that this was repairable, and neither
 * changed the report.
 *
 * What does work is exactly what the player had been doing by hand: launching
 * each game once on the flat page, where the read succeeds, after which the
 * ROM lives in IndexedDB (`roms/provider.ts`'s `readAndKeep`) and the folder is
 * never consulted again. This automates that gesture instead of asking the
 * player to perform it once per cartridge.
 *
 * It runs on the flat page, from the press that opens VR, because that is the
 * only place the read is allowed to succeed.
 *
 * Every port is injected, for the reason the rest of this codebase's device
 * code gives: so the sequencing is testable without IndexedDB, without a file
 * system and without a headset.
 */

export interface PreparePorts {
	/** The checksums already on this device, needing no permission ever again. */
	keptChecksums(): Promise<string[]>;
	/**
	 * What the folder's INDEX claims, which is a cache of an older scan.
	 *
	 * Cheap, and only ever used to decide whether to offer a preparation press
	 * - `missingFromDevice` runs on every library change and must not read the
	 * disk. Being wrong here costs one wasted press, which is why the guess is
	 * allowed to be stale.
	 */
	folderChecksums(): Promise<string[]>;
	/**
	 * What is in the folder RIGHT NOW, read and hashed.
	 *
	 * The index cannot be trusted for the work itself. A headset reported
	 * "11/11 games could not be read" over a folder holding six: the index
	 * described a folder that was no longer there, every one of its entries
	 * missed, and the warning counted them all. `scanDirectory` computes each
	 * checksum from the bytes, so it cannot describe a file that is not there.
	 */
	scanFolder(handle: FileSystemDirectoryHandle): Promise<string[]>;
	storedDirectory(): Promise<FileSystemDirectoryHandle | undefined>;
	/** `roms/provider.ts`'s `readAndKeep`: reads from the folder and keeps it. */
	readAndKeep(
		handle: FileSystemDirectoryHandle,
		checksum: string
	): Promise<Uint8Array | null>;
}

export interface PrepareResult {
	/** Newly brought onto the device by this run. */
	prepared: number;
	/** Wanted, missing, and still missing - the folder did not yield them. */
	failed: number;
}

/**
 * What the headset would not be able to open.
 *
 * Answered before the press wherever possible: `requestSession` runs on the
 * transient activation the click carries, so the common path - nothing to
 * prepare - must stay synchronous from click to session.
 *
 * An empty answer on failure, deliberately: a device that cannot say what it
 * holds must not be the reason somebody cannot enter VR. The worst a wrong
 * "nothing missing" costs is the notice on the library panel, which is
 * survivable; a wrong "something missing" would bar the door.
 */
export async function missingFromDevice(
	wanted: readonly string[],
	ports: PreparePorts
): Promise<string[]> {
	try {
		const kept = new Set(await ports.keptChecksums());
		const folder = new Set(await ports.folderChecksums());
		// Both conditions matter. Already kept means nothing to do; absent from
		// this folder means nothing CAN be done, and counting it as work would
		// leave the player pressing a button that prepares nothing forever.
		return wanted.filter((checksum) => !kept.has(checksum) && folder.has(checksum));
	} catch {
		return [];
	}
}

/**
 * Reads every wanted game out of the folder and keeps it.
 *
 * Never throws and never stops early. One unreadable cartridge - renamed,
 * deleted, on a disk that hiccuped - must not cost the player the other
 * thirty-nine, and it must not stop them entering VR either. Failures are
 * counted and reported; the caller decides whether to say anything.
 */
export async function prepareForVr(
	wanted: readonly string[],
	ports: PreparePorts,
	onProgress?: (done: number, total: number) => void
): Promise<PrepareResult> {
	/*
	 * The cheap question first, and the whole point of the ordering.
	 *
	 * Listing what the device already holds is one key query against
	 * IndexedDB. Scanning the folder reads and hashes every cartridge in it.
	 * Asking the expensive question first meant a player whose games were all
	 * transferred already paid for a full folder read on every press, for
	 * nothing - reported as "c'est long", and they were right.
	 *
	 * A game already kept is never re-copied either, which the filter below
	 * has always done; this is about not paying to find that out.
	 */
	let candidates: string[];
	try {
		const kept = new Set(await ports.keptChecksums());
		candidates = wanted.filter((checksum) => !kept.has(checksum));
	} catch {
		// A device that cannot say what it holds is not one to start reading
		// folders on: it would re-copy everything it already has.
		return { prepared: 0, failed: 0 };
	}
	if (candidates.length === 0) return { prepared: 0, failed: 0 };

	let handle: FileSystemDirectoryHandle | undefined;
	try {
		handle = await ports.storedDirectory();
	} catch {
		handle = undefined;
	}
	// No folder is not a failure of this device, it is the ordinary state of one
	// that keeps its games another way. Nothing to read, nothing to report.
	if (!handle) return { prepared: 0, failed: 0 };

	/*
	 * The scan, not the index, decides what is attempted.
	 *
	 * Anything the folder does not actually hold is not work that failed - it
	 * is work that was never possible, and counting it produced a warning about
	 * eleven unreadable games over a folder of six. A game whose ROM lives on
	 * the player's other machine belongs to that machine.
	 */
	let missing: string[];
	try {
		const present = new Set(await ports.scanFolder(handle));
		missing = candidates.filter((checksum) => present.has(checksum));
	} catch {
		// A folder that cannot be scanned yields nothing, and says so as a
		// no-op rather than as a failure the player is asked to act on.
		return { prepared: 0, failed: 0 };
	}
	if (missing.length === 0) return { prepared: 0, failed: 0 };

	let prepared = 0;
	let failed = 0;
	for (const checksum of missing) {
		try {
			if (await ports.readAndKeep(handle, checksum)) prepared++;
			else failed++;
		} catch {
			failed++;
		}
		onProgress?.(prepared + failed, missing.length);
	}

	return { prepared, failed };
}
