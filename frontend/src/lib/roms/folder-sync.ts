/**
 * Aligner ce que cet appareil croit posséder sur ce que le dossier contient.
 *
 * Le serveur tient l'identité d'un jeu et jamais ses octets : c'est l'index du
 * dossier, côté navigateur, qui répond « ce jeu est ici » et décide donc de ce
 * que la bibliothèque montre. Deux moitiés à tenir, et elles ne sont pas
 * symétriques :
 *
 * - un fichier apparu doit s'enregistrer, sinon la ROM est là et le jeu
 *   invisible ;
 * - un fichier disparu doit quitter l'index, sinon le jeu reste annoncé comme
 *   jouable et ne se trahit qu'au lancement.
 *
 * Rien ici ne supprime quoi que ce soit du compte. Retirer la ligne `Game`
 * cascaderait sur ses sauvegardes (`Save.gameId … ON DELETE CASCADE`), et un
 * second appareil au dossier plus pauvre effacerait les jeux du premier. Un
 * jeu retiré d'ici réapparaît dès que son fichier revient, et le panneau du
 * profil le compte entre-temps comme absent de cet appareil.
 *
 * Les dépendances sont injectées parce que la collecte a besoin de deux API
 * navigateur et que la décision, elle, peut se tromper sans que personne le
 * voie. Seule la décision est testée.
 */

import type { LibraryEntry } from './local-library.js';

/** Ce dont la synchronisation a besoin, et rien de plus. */
export interface FolderSyncCalls {
	/** Le contenu réel du dossier, checksums recalculés. */
	scan: () => Promise<LibraryEntry[]>;
	/** Déclare un jeu au compte ; un checksum déjà connu est un no-op côté serveur. */
	register: (checksum: string, filename: string) => Promise<void>;
	/** Les checksums que l'index retient, scan compris. */
	indexed: () => Promise<string[]>;
	/** Retire un checksum de l'index du dossier — jamais des fichiers gardés. */
	forget: (checksum: string) => Promise<void>;
	/**
	 * Le compte connaît-il déjà ce checksum ?
	 *
	 * Sans cette question, chaque passage renvoie les quarante cartouches au
	 * serveur et annonce « 40 jeux ajoutés » alors que rien n'a bougé — le
	 * `POST` répond 200 avec le jeu existant, indistinguable d'une création.
	 * Le compte sait déjà ce qu'il possède, donc la réponse est locale.
	 */
	isKnown?: (checksum: string) => boolean;
	onProgress?: (done: number, total: number, filename: string) => void;
}

export interface FolderSyncResult {
	/** Fichiers du dossier déclarés au compte sans erreur. */
	added: number;
	/** Entrées d'index périmées effectivement retirées. */
	removed: number;
	/** Fichiers que le compte a refusés — illisibles, quota, réseau. */
	failed: number;
	/** Fichiers déjà connus du compte, laissés tranquilles. */
	unchanged: number;
	/** Fichiers trouvés dans le dossier. */
	total: number;
	/** Le scan n'a rien trouvé, donc rien n'a été touché. */
	empty: boolean;
}

export async function syncFolder(calls: FolderSyncCalls): Promise<FolderSyncResult> {
	const entries = await calls.scan();

	// Un scan sans résultat n'est PAS un dossier vidé de ses ROMs : c'est aussi
	// un disque externe débranché, un dossier renommé, une permission qui vient
	// d'être révoquée. Purger ici viderait la bibliothèque de l'appareil au
	// pire moment, alors que l'état est temporaire. On ne touche à rien et on
	// le dit à l'appelant, qui a une phrase pour le joueur.
	if (entries.length === 0) {
		return { added: 0, removed: 0, failed: 0, unchanged: 0, total: 0, empty: true };
	}

	let added = 0;
	let failed = 0;
	let unchanged = 0;
	for (const [i, entry] of entries.entries()) {
		calls.onProgress?.(i + 1, entries.length, entry.filename);
		if (calls.isKnown?.(entry.checksum)) {
			unchanged++;
			continue;
		}
		try {
			await calls.register(entry.checksum, entry.filename);
			added++;
		} catch {
			// Une cartouche illisible ne doit pas abandonner les trente-neuf
			// autres. Le compte est rendu à l'appelant, qui saura le dire.
			failed++;
		}
	}

	const inFolder = new Set(entries.map((e) => e.checksum));
	let removed = 0;
	for (const checksum of await calls.indexed()) {
		if (inFolder.has(checksum)) continue;
		try {
			await calls.forget(checksum);
			removed++;
		} catch {
			// Une purge ratée laisse un jeu affiché à tort : gênant, jamais
			// destructeur. Ce qui serait grave est d'échouer la synchronisation
			// entière et de perdre les ajouts qui viennent de réussir.
		}
	}

	return { added, removed, failed, unchanged, total: entries.length, empty: false };
}
