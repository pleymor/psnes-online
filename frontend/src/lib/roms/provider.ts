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
	hasAccess,
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

/**
 * Garder est un confort, jamais une condition.
 *
 * En navigation privée, sur un quota plein ou sur une base qu'un autre onglet
 * bloque, écrire lève. Laisser ce rejet remonter ferait refuser un fichier que
 * le joueur vient de désigner et qu'on a déjà validé : on lui dirait que son
 * bon fichier est mauvais, à l'endroit exact où l'on dit « ce fichier est un
 * autre dump ». Les octets restent dans le cache de session, donc la partie
 * démarre ; seul le confort du prochain lancement est perdu.
 */
async function keepQuietly(checksum: string, bytes: Uint8Array): Promise<void> {
	try {
		await kept()?.keep(checksum, bytes);
	} catch {
		// Rien à dire ici : ce module n'a pas le contexte qui rendrait une ligne
		// de log lisible, et l'appelant n'a aucune décision à prendre là-dessus.
	}
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
 * Options for {@link resolveQuietly}.
 */
export interface ResolveQuietlyOptions {
	/**
	 * Whether a lapsed folder permission may be re-requested.
	 *
	 * Defaults to true - re-granting from the gesture that triggered the
	 * launch is how a flat page recovers a folder permission that lapsed
	 * between sessions, and it is the behaviour every existing caller relies
	 * on. Pass false only where the browser's own permission dialog would
	 * itself be the problem: in the immersive VR session, a `select` event is
	 * a real user gesture, so `requestPermission` does not fail quietly there
	 * - it shows the native prompt and throws the player out of the headset.
	 */
	requestPermission?: boolean;
}

/**
 * Finds a ROM without asking the player anything.
 *
 * Returns null rather than throwing when it comes up empty: not finding the
 * file is the expected state on a browser with no folder picker, and the
 * caller's job is then to ask.
 */
export async function resolveQuietly(
	checksum: string,
	options?: ResolveQuietlyOptions
): Promise<Uint8Array | null> {
	const cached = cache.get(checksum);
	if (cached) return cached;

	// Avant le dossier : lire une entrée d'IndexedDB coûte moins qu'ouvrir un
	// fichier, et un appareil sans dossier n'a que cette source.
	const store = kept();
	if (store) {
		// Un stockage qui refuse de répondre est indiscernable, ici, d'un
		// stockage vide : dans les deux cas ces octets ne sont pas là et il
		// reste le dossier à essayer. Laisser lever contredirait le contrat
		// annoncé juste au-dessus et ferait échouer un démarrage.
		const bytes = await store.read(checksum).catch(() => null);
		if (bytes) {
			cache.set(checksum, bytes);
			return bytes;
		}
	}

	if (!supportsDirectoryPicker()) return null;

	try {
		const handle = await storedDirectory();
		if (!handle) return null;

		// Permission on a stored folder lapses between sessions. Whether it is
		// worth re-requesting is not this function's call to make - it is the
		// caller's, via `options.requestPermission` - because only the caller
		// knows whether a native permission prompt right now is recoverable
		// (a flat page) or a disaster (an immersive session with no page behind
		// it to show the prompt on).
		const granted =
			options?.requestPermission === false ? await hasAccess(handle) : await ensureAccess(handle);
		if (!granted) return null;

		const bytes = await readRomByChecksum(handle, checksum);
		if (bytes) cache.set(checksum, bytes);
		return bytes;
	} catch {
		// Même raison : un dossier illisible n'est pas trouvé, et l'appelant sait
		// déjà quoi faire d'un « non ».
		return null;
	}
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

	// Chaque source est isolée : celle qui répond doit être affichée même quand
	// l'autre lève. Un rejet ici laisserait `resolvable` à `null` pour toujours
	// dans les deux pages qui appellent ceci depuis `onMount`, donc une
	// bibliothèque non filtrée et une promesse non gérée.
	const store = kept();
	if (store) {
		for (const checksum of await store.checksums().catch(() => [])) here.add(checksum);
	}

	if (supportsDirectoryPicker()) {
		for (const checksum of await indexedChecksums().catch(() => [])) here.add(checksum);
	}

	return [...here];
}

/** Ce qu'un fichier désigné vaut : son identité réelle, et ses octets. */
export interface DesignatedRom {
	checksum: string;
	bytes: Uint8Array;
}

/**
 * Le seul endroit où un fichier désigné par le joueur devient une source.
 *
 * L'invariant est « un fichier que le joueur désigne est gardé », et il y a
 * trois gestes qui désignent : la modale qui réclame la ROM d'une partie,
 * l'ajout d'un fichier depuis le profil - seul moyen d'ajouter un jeu sur
 * Firefox et Safari - et la réparation d'une entrée héritée sans checksum. Les
 * trois passent par ici, sans quoi deux d'entre eux enregistreraient une
 * identité côté serveur en jetant les octets, et le jeu n'apparaîtrait dans la
 * bibliothèque d'aucun appareil.
 *
 * Le checksum est recalculé depuis le contenu ; un nom de fichier n'est jamais
 * une preuve. Avec `expected`, un contenu qui ne correspond pas est refusé
 * avant d'être ni mis en cache ni gardé : garder une ROM sous le checksum
 * qu'elle n'a pas la rendrait résoluble et injouable. Refuser ici, le joueur
 * encore devant son sélecteur, vaut mieux que trois secondes de partie
 * désynchronisée.
 */
export async function designateFile(file: File, expected?: string): Promise<DesignatedRom> {
	const bytes = await romBytes(file);
	const checksum = crc32(normaliseRom(bytes));
	if (expected !== undefined && checksum !== expected) {
		throw new Error(`That file is a different dump (${checksum}, expected ${expected})`);
	}
	cache.set(checksum, bytes);
	await keepQuietly(checksum, bytes);
	return { checksum, bytes };
}

/**
 * Accepts a file the player picked, but only if it is the right game.
 *
 * The room's own shape of designating a file: the checksum is known in advance
 * and anything else is refused.
 */
export async function offerFile(file: File, expected: string): Promise<Uint8Array> {
	return (await designateFile(file, expected)).bytes;
}
