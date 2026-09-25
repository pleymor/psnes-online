/**
 * La bibliothèque du joueur sans compte : ce que cet appareil sait ouvrir,
 * titré par le nom de fichier.
 *
 * Avec un compte, titre, jaquette et métadonnées viennent du serveur, résolus
 * depuis le checksum. Sans compte il ne reste que le nom de fichier, et c'est
 * la décision de #70 §4.3 : le nom, sans jaquette, et rien en cache. Le cache
 * des métadonnées appartient à #71, celui où un joueur AVEC un compte joue
 * hors-ligne et a donc déjà vu ses jaquettes.
 *
 * `localGames` est pure ; la collecte est en bas. Aucun import `$lib`.
 */

import { romBaseName } from '../saves/local-rules.js';
import { indexedEntries } from './local-library.js';
import { resolvableHere } from './provider.js';
import { openLocalDb, TITLES } from '../saves/local-store.js';

export interface LocalGame {
	checksum: string;
	/** Le nom affiché : le fichier sans son extension, ou le checksum faute de mieux. */
	title: string;
	/** Le nom du fichier dans le dossier, s'il y est. C'est lui qui nomme le `.srm`. */
	filename: string | null;
}

/**
 * Les jeux ouvrables ici, triés par titre.
 *
 * `resolvable` fait foi pour ce qui apparaît : un nom sans octets derrière
 * serait un jeu qu'on ne peut pas lancer. Le dossier nomme d'abord, parce que
 * c'est le fichier que le joueur voit ; un nom retenu pour une ROM désignée à
 * la main ensuite ; le checksum en dernier, pour qu'une entrée ne soit jamais
 * un titre vide.
 */
export function localGames(input: {
	resolvable: Iterable<string>;
	folder: ReadonlyArray<{ checksum: string; filename: string }>;
	titles: ReadonlyMap<string, string>;
}): LocalGame[] {
	const inFolder = new Map(input.folder.map((e) => [e.checksum, e.filename]));
	const seen = new Set<string>();
	const games: LocalGame[] = [];
	for (const checksum of input.resolvable) {
		if (seen.has(checksum)) continue;
		seen.add(checksum);
		const filename = inFolder.get(checksum) ?? null;
		const named = filename ?? input.titles.get(checksum) ?? null;
		games.push({ checksum, filename, title: named ? romBaseName(named) : checksum });
	}
	return games.sort((a, b) => a.title.localeCompare(b.title));
}

/* ------------------------------------------------------------ la collecte */

async function titles(): Promise<Map<string, string>> {
	const db = await openLocalDb();
	try {
		return await new Promise((resolve, reject) => {
			const store = db.transaction(TITLES, 'readonly').objectStore(TITLES);
			const keys = store.getAllKeys();
			const values = store.getAll();
			values.onsuccess = () =>
				resolve(
					new Map(
						(keys.result as string[]).map((k, i) => [k, String((values.result as unknown[])[i])])
					)
				);
			values.onerror = () => reject(values.error);
		});
	} finally {
		db.close();
	}
}

/** Retient le nom d'un fichier désigné à la main : `kept-files` ne garde que ses octets. */
export async function rememberTitle(checksum: string, filename: string): Promise<void> {
	const db = await openLocalDb();
	try {
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(TITLES, 'readwrite');
			tx.objectStore(TITLES).put(filename, checksum);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

/** Chaque source isolée : celle qui répond est affichée même si l'autre lève. */
export async function listLocalGames(): Promise<LocalGame[]> {
	const [resolvable, folder, named] = await Promise.all([
		resolvableHere(),
		indexedEntries().catch(() => []),
		titles().catch(() => new Map<string, string>())
	]);
	return localGames({ resolvable, folder, titles: named });
}
