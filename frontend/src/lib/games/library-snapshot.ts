/**
 * La bibliothèque d'un compte telle qu'elle a été vue en ligne, pour qu'elle
 * ressemble à elle-même hors-ligne (#71 §7.4).
 *
 * Ce qui est gardé, et où :
 *
 *  - **les titres et les métadonnées**, ici, dans IndexedDB, clés par compte.
 *    Pas dans le cache du service worker : `/api/games` est une réponse
 *    authentifiée, et une réponse authentifiée servie depuis un cache après une
 *    déconnexion, ou à un autre compte du même navigateur, est une fuite. Une
 *    copie clée par compte, lue seulement pour le compte retenu et effacée à
 *    sa déconnexion, n'a pas ce défaut ;
 *  - **les jaquettes**, dans le cache du service worker (`COVERS_CACHE`),
 *    parce qu'elles sont publiques - `/covers/<empreinte>.webp` n'appartient à
 *    personne - et servies en stale-while-revalidate.
 *
 * Rafraîchie chaque fois que `/api/games` répond, donc au retour du réseau.
 * Invalidée quand le serveur dit qu'une fiche a changé : une jaquette que la
 * nouvelle liste ne cite plus est retirée du cache, pour qu'une correction de
 * la communauté ne soit pas masquée par l'ancienne image.
 *
 * `snapshotOf` et `coversToForget` sont pures ; la collecte est en bas.
 * Aucun import `$lib`.
 */

import { openLocalDb, LIBRARY } from '../saves/local-store.js';

/** Ce qu'un jeu de la bibliothèque garde pour l'écran hors-ligne. */
export interface SnapshotGame {
	id: string;
	title: string;
	filename: string;
	crc32: string | null;
	coverUrl: string | null;
	genre: string | null;
	publisher: string | null;
	releaseDate: string | null;
	players: string | null;
	sramUpdatedAt: string | null;
}

export interface LibrarySnapshot {
	userId: string;
	takenAt: number;
	games: SnapshotGame[];
}

type Listed = {
	id: string;
	title: string;
	filename: string;
	crc32?: string | null;
	coverUrl?: string | null;
	genre?: string | null;
	publisher?: string | null;
	releaseDate?: string | null;
	players?: string | null;
	sramUpdatedAt?: string | null;
};

/**
 * Les champs qui servent à l'affichage, et rien d'autre.
 *
 * Les résumés de sauvegarde (`saves`) restent dehors : ils portent des
 * vignettes en data URL, donc l'essentiel du poids, et un écran hors-ligne
 * ne peut de toute façon pas charger un savestate qui est sur le serveur.
 */
export function snapshotOf(userId: string, games: readonly Listed[], takenAt: number): LibrarySnapshot {
	return {
		userId,
		takenAt,
		games: games.map((g) => ({
			id: g.id,
			title: g.title,
			filename: g.filename,
			crc32: g.crc32 ?? null,
			coverUrl: g.coverUrl ?? null,
			genre: g.genre ?? null,
			publisher: g.publisher ?? null,
			releaseDate: g.releaseDate ?? null,
			players: g.players ?? null,
			sramUpdatedAt: g.sramUpdatedAt ?? null
		}))
	};
}

/**
 * Les jaquettes que la liste précédente citait et que la nouvelle ne cite
 * plus : une fiche corrigée, un jeu retiré. Une URL encore citée par un autre
 * jeu reste - deux dumps d'une même cartouche partagent leur image.
 */
export function coversToForget(
	previous: LibrarySnapshot | null,
	next: LibrarySnapshot
): string[] {
	if (!previous) return [];
	const still = new Set(next.games.map((g) => g.coverUrl).filter((u): u is string => !!u));
	const gone = new Set<string>();
	for (const g of previous.games) if (g.coverUrl && !still.has(g.coverUrl)) gone.add(g.coverUrl);
	return [...gone];
}

/** Un jeu tel que la bibliothèque hors-ligne d'un compte l'affiche. */
export interface OfflineGame extends SnapshotGame {
	crc32: string;
	/** Vu en ligne sous ce compte, ou seulement présent sur cet appareil. */
	seen: boolean;
}

/**
 * La bibliothèque hors-ligne d'un compte : ce que la bibliothèque en ligne
 * aurait montré sur cet appareil.
 *
 * Même filtre que `deviceLibrary` en ligne - un jeu dont cet appareil n'a pas
 * les octets ne se lance pas, donc ne s'affiche pas - avec la fiche et la
 * jaquette vues en ligne. Un jeu présent sur l'appareil mais jamais vu sous ce
 * compte reste proposé, titré par son nom de fichier comme en #70 : il se
 * joue, et sa SRAM attendra dans la file le jour où il entrera dans la
 * bibliothèque.
 */
export function offlineLibrary(input: {
	snapshot: LibrarySnapshot | null;
	resolvable: Iterable<string>;
	local: ReadonlyArray<{ checksum: string; title: string; filename: string | null }>;
}): OfflineGame[] {
	/*
	 * Une cartouche, une carte : la clé est le CRC32, écrit d'une seule façon.
	 *
	 * Le client l'écrit en majuscules (`roms/checksum.ts`) et le serveur n'en
	 * accepte pas d'autre, mais une clé qui dépend de la casse de deux sources
	 * est exactement le défaut qui donne deux fois le même jeu, l'un avec sa
	 * jaquette, l'autre titré par son fichier. Le premier vu gagne, dans les
	 * deux listes : l'ordre du serveur ne doit pas faire changer la fiche.
	 */
	const key = (crc: string) => crc.toUpperCase();
	const here = new Set([...input.resolvable].map(key));
	const seen = new Map<string, SnapshotGame>();
	for (const g of input.snapshot?.games ?? []) {
		if (g.crc32 && !seen.has(key(g.crc32))) seen.set(key(g.crc32), g);
	}

	const shown: OfflineGame[] = [];
	for (const [crc32, g] of seen) if (here.has(crc32)) shown.push({ ...g, crc32, seen: true });
	const alone = new Set<string>();
	for (const l of input.local) {
		const crc32 = key(l.checksum);
		if (seen.has(crc32) || alone.has(crc32) || !here.has(crc32)) continue;
		alone.add(crc32);
		shown.push({
			id: crc32,
			title: l.title,
			filename: l.filename ?? l.title,
			crc32,
			coverUrl: null,
			genre: null,
			publisher: null,
			releaseDate: null,
			players: null,
			sramUpdatedAt: null,
			seen: false
		});
	}
	return shown.sort((a, b) => a.title.localeCompare(b.title));
}

/* ------------------------------------------------------------ la collecte */

async function inLibrary<T>(
	mode: IDBTransactionMode,
	run: (s: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
	const db = await openLocalDb();
	try {
		return await new Promise<T | undefined>((resolve, reject) => {
			const tx = db.transaction(LIBRARY, mode);
			const request = run(tx.objectStore(LIBRARY));
			tx.oncomplete = () => resolve(request ? request.result : undefined);
			tx.onerror = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

export async function readLibrarySnapshot(userId: string): Promise<LibrarySnapshot | null> {
	return ((await inLibrary<LibrarySnapshot | undefined>('readonly', (s) => s.get(userId))) ?? null) as
		| LibrarySnapshot
		| null;
}

export async function writeLibrarySnapshot(snapshot: LibrarySnapshot): Promise<void> {
	await inLibrary('readwrite', (s) => {
		s.put(snapshot, snapshot.userId);
	});
}

export async function forgetLibrarySnapshot(userId: string): Promise<void> {
	await inLibrary('readwrite', (s) => {
		s.delete(userId);
	});
}
