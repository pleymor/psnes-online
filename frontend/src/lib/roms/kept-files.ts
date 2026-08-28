/**
 * Les ROMs qu'un appareil garde parce que le joueur les lui a désignées.
 *
 * Le dossier fait foi là où il y en a un, mais `showDirectoryPicker` n'existe
 * que sur Chromium : sans ce store, Firefox et Safari auraient une
 * bibliothèque définitivement vide et aucun recours - exactement ce contre quoi
 * l'en-tête de `source-state.ts` met en garde. Un fichier désigné à la main
 * entre ici, et l'appareil se remplit au fil des parties.
 *
 * Ce qu'un hôte envoie n'y entre jamais : recevoir n'est pas posséder, et c'est
 * une décision du propriétaire, pas une limitation technique.
 *
 * L'interface existe pour que la règle soit testable sans IndexedDB, sur le
 * modèle de `readDirectionMode` dans `controls/touch.ts`.
 */

const DB_NAME = 'psnes-roms';
/** 2 ajoute le store `files`. La v1 n'avait que `handles` et `index`. */
const DB_VERSION = 2;
const HANDLES = 'handles';
const INDEX = 'index';
const FILES = 'files';

export interface KeptFiles {
	keep(checksum: string, bytes: Uint8Array): Promise<void>;
	read(checksum: string): Promise<Uint8Array | null>;
	checksums(): Promise<string[]>;
	forget(checksum: string): Promise<void>;
}

/** Whether this browser can keep anything at all. */
export function keptFilesAvailable(): boolean {
	return typeof indexedDB !== 'undefined';
}

/** Pour les tests, et pour tout appelant qui ne veut rien persister. */
export function memoryKeptFiles(): KeptFiles {
	const store = new Map<string, Uint8Array>();
	return {
		async keep(checksum, bytes) {
			store.set(checksum, bytes);
		},
		async read(checksum) {
			return store.get(checksum) ?? null;
		},
		async checksums() {
			return [...store.keys()];
		},
		async forget(checksum) {
			store.delete(checksum);
		}
	};
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			// Les trois stores sont créés ici parce qu'une base ouverte en v2 par
			// ce module doit rester complète pour `local-library.ts`, qui ouvre la
			// même base et n'a aucune garantie d'arriver le premier.
			if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
			if (!db.objectStoreNames.contains(INDEX)) db.createObjectStore(INDEX);
			if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** L'implémentation de production. */
export function indexedDbKeptFiles(): KeptFiles {
	return {
		async keep(checksum, bytes) {
			const db = await openDb();
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(FILES, 'readwrite');
				// Une copie : le tableau de l'appelant peut être une vue sur un
				// tampon qu'il réutilise, et IndexedDB structure-clone à la validation
				// de la transaction, pas à l'appel.
				tx.objectStore(FILES).put(bytes.slice(), checksum);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		},
		async read(checksum) {
			const db = await openDb();
			const value = await new Promise<Uint8Array | undefined>((resolve, reject) => {
				const tx = db.transaction(FILES, 'readonly');
				const request = tx.objectStore(FILES).get(checksum);
				request.onsuccess = () => resolve(request.result as Uint8Array | undefined);
				request.onerror = () => reject(request.error);
			});
			db.close();
			return value ?? null;
		},
		async checksums() {
			const db = await openDb();
			const keys = await new Promise<string[]>((resolve, reject) => {
				const tx = db.transaction(FILES, 'readonly');
				const request = tx.objectStore(FILES).getAllKeys();
				request.onsuccess = () => resolve(request.result as string[]);
				request.onerror = () => reject(request.error);
			});
			db.close();
			return keys;
		},
		async forget(checksum) {
			const db = await openDb();
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(FILES, 'readwrite');
				tx.objectStore(FILES).delete(checksum);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		}
	};
}
