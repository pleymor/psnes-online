/**
 * Turning a game's checksum into its bytes, without a server.
 *
 * Every launch path goes through here, and there are only three places the
 * bytes can come from: this session's memory, the folder the player picked
 * once, or the player pointing at the file right now. They are tried in that
 * order because they cost the player nothing, one gesture, and one gesture per
 * launch respectively.
 *
 * The guest is the case that shapes this. They join a room for a game they do
 * not own a row for; all they get is the checksum, and they have to find their
 * own copy of the same cartridge. A mismatch here is not a detail - two
 * different dumps desynchronise lockstep within seconds - so nothing is
 * accepted without its checksum being recomputed.
 *
 * Deliberately free of SvelteKit aliases and of the logger, so it runs under
 * plain node in the test suite. Callers do the logging; they have the room and
 * player context that makes a line worth reading anyway.
 */

import { crc32, normaliseRom } from './checksum.js';
import {
	ensureAccess,
	indexedChecksums,
	readRomByChecksum,
	romBytes,
	storedDirectory,
	supportsDirectoryPicker
} from './local-library.js';
import {
	indexedDbKeptFiles,
	keptFilesAvailable,
	type KeptFiles
} from './kept-files.js';

/** Bytes already read this session, so a rematch does not re-read the disk. */
const cache = new Map<string, Uint8Array>();

/**
 * Les octets que cet appareil a gardés, ou null là où rien ne peut l'être.
 *
 * Résolu paresseusement : `keptFilesAvailable()` lit `indexedDB`, qui n'existe
 * pas sous node, et ce module est importé par des tests qui n'en veulent pas.
 */
let keptStore: KeptFiles | null | undefined;

function kept(): KeptFiles | null {
	if (keptStore === undefined) {
		keptStore = keptFilesAvailable() ? indexedDbKeptFiles() : null;
	}
	return keptStore;
}

/** Remplace le store, pour les tests. `null` revient au comportement réel. */
export function useKeptFiles(store: KeptFiles | null): void {
	keptStore = store ?? undefined;
}

/** Keeps bytes the player has just supplied, keyed by what they actually contain. */
export function remember(bytes: Uint8Array): string {
	const checksum = crc32(normaliseRom(bytes));
	cache.set(checksum, bytes);
	return checksum;
}

export function isCached(checksum: string): boolean {
	return cache.has(checksum);
}

/**
 * Finds a ROM without asking the player anything.
 *
 * Returns null rather than throwing when it comes up empty: not finding the
 * file is the expected state on a browser with no folder picker, and the
 * caller's job is then to ask.
 */
export async function resolveQuietly(checksum: string): Promise<Uint8Array | null> {
	const cached = cache.get(checksum);
	if (cached) return cached;

	// Avant le dossier : lire une entrée d'IndexedDB coûte moins qu'ouvrir un
	// fichier, et un appareil sans dossier n'a que cette source.
	const store = kept();
	if (store) {
		const bytes = await store.read(checksum);
		if (bytes) {
			cache.set(checksum, bytes);
			return bytes;
		}
	}

	if (!supportsDirectoryPicker()) return null;

	const handle = await storedDirectory();
	if (!handle) return null;

	// Permission on a stored folder lapses between sessions, and re-granting it
	// needs a user gesture we do not have here. Silence is the correct answer.
	if (!(await ensureAccess(handle))) return null;

	const bytes = await readRomByChecksum(handle, checksum);
	if (bytes) cache.set(checksum, bytes);
	return bytes;
}

/**
 * Les checksums que cet appareil sait ouvrir sans rien demander.
 *
 * L'union des deux sources, et rien d'autre : c'est ce que la bibliothèque
 * affiche. Le dossier est consulté par son index plutôt que relu, parce que
 * cette question est posée à chaque ouverture de page et qu'un scan de quarante
 * cartouches ne peut pas s'y trouver.
 */
export async function resolvableHere(): Promise<string[]> {
	// Le cache de session est délibérément absent : il retient les octets d'une
	// ROM reçue d'un hôte, que le joueur ne possède pas, et il survit à la
	// disparition de la source. Le faire compter ferait exactement mentir la
	// liste que ceci existe pour rendre honnête.
	const here = new Set<string>();

	const store = kept();
	if (store) for (const checksum of await store.checksums()) here.add(checksum);

	if (supportsDirectoryPicker()) {
		for (const checksum of await indexedChecksums()) here.add(checksum);
	}

	return [...here];
}

/**
 * Accepts a file the player picked, but only if it is the right game.
 *
 * The checksum is recomputed from the contents; a filename is never proof.
 * Rejecting here, with the player still in front of a picker, is far kinder
 * than letting a wrong ROM start and desynchronise a match.
 */
export async function offerFile(file: File, expected: string): Promise<Uint8Array> {
	const bytes = await romBytes(file);
	const actual = crc32(normaliseRom(bytes));
	if (actual !== expected) {
		throw new Error(`That file is a different dump (${actual}, expected ${expected})`);
	}
	cache.set(expected, bytes);
	// Gardé seulement après validation : une ROM qui ne correspond pas au jeu
	// demandé, une fois gardée, serait annoncée par la bibliothèque et
	// échouerait au lancement.
	await kept()?.keep(expected, bytes);
	return bytes;
}
