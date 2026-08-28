/**
 * The player's ROM files, which never leave their machine.
 *
 * The server holds a game's identity - title, cover, saves - keyed by the
 * checksum of the ROM, and never the bytes. This module is what turns that
 * checksum back into a file at launch.
 *
 * Asking for a folder rather than a file is the whole trick: picked once, the
 * app can then find whichever game it needs by checksum instead of asking
 * "which file is Secret of Mana?" every session.
 */

import { crc32, normaliseRom, unzipFirstEntry } from './checksum.js';

const DB_NAME = 'psnes-roms';
/**
 * 2 ajoute le store `files` (voir `kept-files.ts`).
 *
 * Les deux modules ouvrent la même base et l'un ou l'autre peut arriver le
 * premier, donc les deux doivent connaître la même version et créer les trois
 * stores : ouvrir en v1 après une v2 lève `VersionError` et laisse le joueur
 * sans bibliothèque du tout.
 */
const DB_VERSION = 2;
const HANDLES = 'handles';
/** checksum -> filename, so a later launch reads one file instead of hashing a folder. */
const INDEX = 'index';
const FILES = 'files';

export const ROM_EXTENSIONS = ['.smc', '.sfc', '.fig', '.swc', '.mgd', '.zip'];

export interface LibraryEntry {
	checksum: string;
	filename: string;
	size: number;
}

/** Whether this browser can remember a folder between sessions. */
export function supportsDirectoryPicker(): boolean {
	return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/* --------------------------------------------------------------- storage */

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
			if (!db.objectStoreNames.contains(INDEX)) db.createObjectStore(INDEX);
			if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function put(store: string, key: string, value: unknown): Promise<void> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(store, 'readwrite');
		tx.objectStore(store).put(value, key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
	db.close();
}

async function get<T>(store: string, key: string): Promise<T | undefined> {
	const db = await openDb();
	const value = await new Promise<T | undefined>((resolve, reject) => {
		const tx = db.transaction(store, 'readonly');
		const request = tx.objectStore(store).get(key);
		request.onsuccess = () => resolve(request.result as T | undefined);
		request.onerror = () => reject(request.error);
	});
	db.close();
	return value;
}

/* ------------------------------------------------------------- the folder */

/**
 * Asks for the folder the player keeps their ROMs in, and remembers it.
 *
 * The handle survives in IndexedDB, but the *permission* attached to it does
 * not: browsers re-ask on a new session. `ensureAccess` handles that, and it
 * has to be called from a user gesture.
 */
export async function chooseDirectory(): Promise<boolean> {
	if (!supportsDirectoryPicker()) return false;
	const handle = await (
		window as unknown as { showDirectoryPicker(o?: unknown): Promise<FileSystemDirectoryHandle> }
	).showDirectoryPicker({ id: 'psnes-roms', mode: 'read' });
	await put(HANDLES, 'directory', handle);
	return true;
}

export async function storedDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
	return get<FileSystemDirectoryHandle>(HANDLES, 'directory');
}

/**
 * Re-grants read permission on a stored folder.
 *
 * Returns false when the browser wants a fresh gesture, which is not an error
 * - it is the normal state at the start of a session.
 */
export async function ensureAccess(handle: FileSystemDirectoryHandle): Promise<boolean> {
	const withPermissions = handle as unknown as {
		queryPermission(d: { mode: string }): Promise<PermissionState>;
		requestPermission(d: { mode: string }): Promise<PermissionState>;
	};
	if ((await withPermissions.queryPermission({ mode: 'read' })) === 'granted') return true;
	try {
		return (await withPermissions.requestPermission({ mode: 'read' })) === 'granted';
	} catch {
		// The spec requires transient activation (a user gesture) for
		// requestPermission; off a gesture - e.g. called from onMount - it
		// rejects with a SecurityError instead of resolving to 'denied'. A
		// permission that cannot even be requested right now is, for every
		// caller's purposes, simply not granted.
		return false;
	}
}

/* --------------------------------------------------------------- reading */

function looksLikeRom(name: string): boolean {
	const lower = name.toLowerCase();
	return ROM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Every ROM in the folder, with its checksum. */
export async function scanDirectory(handle: FileSystemDirectoryHandle): Promise<LibraryEntry[]> {
	const entries: LibraryEntry[] = [];
	const iterable = handle as unknown as AsyncIterable<[string, FileSystemHandle]>;

	for await (const [name, child] of iterable) {
		if (child.kind !== 'file' || !looksLikeRom(name)) continue;
		const file = await (child as FileSystemFileHandle).getFile();
		const checksum = await checksumOf(file);
		entries.push({ checksum, filename: name, size: file.size });
		// Remembered so the next launch opens one file instead of reading them all.
		await put(INDEX, checksum, name);
	}
	return entries;
}

/**
 * Finds a game's bytes by checksum.
 *
 * Tries the remembered filename first, and only falls back to a full scan when
 * that misses - a folder of forty cartridges is tens of megabytes to read.
 */
export async function readRomByChecksum(
	handle: FileSystemDirectoryHandle,
	checksum: string
): Promise<Uint8Array | null> {
	const remembered = await get<string>(INDEX, checksum);
	if (remembered) {
		const bytes = await tryRead(handle, remembered, checksum);
		if (bytes) return bytes;
	}

	for (const entry of await scanDirectory(handle)) {
		if (entry.checksum !== checksum) continue;
		return tryRead(handle, entry.filename, checksum);
	}
	return null;
}

async function tryRead(
	handle: FileSystemDirectoryHandle,
	filename: string,
	expected: string
): Promise<Uint8Array | null> {
	try {
		const file = await handle.getFileHandle(filename).then((h) => h.getFile());
		const bytes = await romBytes(file);
		// The name is a hint, never proof: the file may have been replaced.
		return crc32(normaliseRom(bytes)) === expected ? bytes : null;
	} catch {
		return null;
	}
}

/* ------------------------------------------------------- a single file in */

/**
 * Reads a file the player picked, expanding it if it is an archive.
 *
 * Unzipping here rather than later means nothing downstream ever sees a zip -
 * not the checksum, not the emulator. The alternative is a core that loads the
 * archive bytes, runs at a full 60fps and renders black.
 */
export async function romBytes(file: File): Promise<Uint8Array> {
	return unzipFirstEntry(new Uint8Array(await file.arrayBuffer()));
}

export async function checksumOf(file: File): Promise<string> {
	return crc32(normaliseRom(await romBytes(file)));
}

/* ----------------------------------------------------------- the server */

/**
 * Registers one game: its identity, never its contents.
 *
 * Throws on failure rather than returning a flag - the folder scan relies on
 * that to catch a single bad entry without losing track of which one it was.
 */
export async function registerGame(checksum: string, filename: string): Promise<void> {
	const res = await fetch('/api/games', {
		method: 'POST',
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ checksum, filename })
	});
	if (!res.ok) {
		const payload = await res.json().catch(() => ({}));
		throw new Error(payload.error || `HTTP ${res.status}`);
	}
}
