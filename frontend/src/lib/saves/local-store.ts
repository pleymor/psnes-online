/**
 * Le magasin de sauvegardes local : lire, écrire, lister, par checksum et par
 * emplacement.
 *
 * C'est l'interface étroite que #70 §9 demande, et elle est étroite exprès :
 * aujourd'hui seul le joueur sans compte l'utilise, mais le ticket suivant
 * (#71) en fait le chemin d'écriture de TOUT le monde - le local fait toujours
 * autorité, le serveur devient un second destinataire. Il remplacera
 * l'implémentation, ou l'enveloppera, pas ses appelants. Rien ici ne parle
 * donc de salon, de socket ou de compte : un jeu est un checksum, une
 * sauvegarde est un emplacement.
 *
 * Deux endroits où une copie peut vivre :
 *
 * - **le dossier de ROMs**, à côté de la cartouche : `<rom>.srm` octet pour
 *   octet, `<rom>.state1`… pour les savestates (`local-rules.ts` dit pourquoi).
 *   Ces trois emplacements ne sont plus écrits : les savestates vont
 *   désormais dans `local-states.ts`, nommés et sans limite, comme ceux d'un
 *   compte. Ceux qui existent se lisent encore, depuis le menu de chargement ;
 * - **l'appareil**, dans IndexedDB, quand le dossier n'est pas possible :
 *   Firefox et Safari, un dossier sans permission d'écriture, une ROM désignée
 *   à la main qui n'est dans aucun dossier.
 *
 * Les deux sont des ports, pour que la règle se teste sans navigateur. Les
 * implémentations de production sont en bas du fichier.
 *
 * Aucun import `$lib` : `core/test` tourne sous node nu.
 */

import {
	deviceSaveKey,
	newestSave,
	saveDestination,
	saveFileName,
	STATE_SLOTS,
	type DeviceReason,
	type DestinationFacts,
	type SaveSlot,
	type StampedSave
} from './local-rules.js';
import {
	hasAccess,
	hasWriteAccess,
	indexedDbFolderIndex,
	storedDirectory,
	supportsDirectoryPicker
} from '../roms/local-library.js';

export type { SaveSlot, StampedSave } from './local-rules.js';

/** Où une copie a été lue ou écrite. */
export type SaveWhere = 'folder' | 'device';

/** Le résultat d'une écriture : où elle a atterri, et pourquoi pas au dossier. */
export type SaveWritten =
	| { where: 'folder' }
	| { where: 'device'; reason: DeviceReason | 'folder-failed' };

export interface SaveRecord extends StampedSave {
	from: SaveWhere;
}

export interface SaveListing {
	slot: SaveSlot;
	savedAt: number;
	from: SaveWhere;
}

/**
 * L'interface que les écrans connaissent, et la seule.
 *
 * `read` LÈVE quand il n'a pas pu lire, et rend `null` quand il n'y a rien à
 * lire. La différence est l'invariant de `SoloRoom.svelte` : n'avoir pas pu
 * lire une sauvegarde interdit de l'écrire, sans quoi la SRAM vierge d'une ROM
 * fraîchement chargée écrase la vraie. Un `null` sur échec effacerait cette
 * différence, et la progression avec.
 */
export interface LocalSaveStore {
	read(checksum: string, slot: SaveSlot): Promise<SaveRecord | null>;
	write(checksum: string, slot: SaveSlot, bytes: Uint8Array): Promise<SaveWritten>;
	/** Les emplacements occupés pour ce jeu, SRAM comprise, dans l'ordre des emplacements. */
	list(checksum: string): Promise<SaveListing[]>;
}

/** Le dossier de ROMs, vu du magasin. */
export interface SaveFolder {
	/** Ce qui décide si une écriture peut y aller - interrogé, jamais demandé. */
	facts(): Promise<Omit<DestinationFacts, 'romFilename'> & { readGranted: boolean }>;
	/** Le nom de la ROM de ce checksum dans le dossier, ou null. */
	romFilename(checksum: string): Promise<string | null>;
	/** `null` si le fichier n'existe pas ; lève si le dossier n'a pas pu être lu. */
	readFile(name: string): Promise<StampedSave | null>;
	writeFile(name: string, bytes: Uint8Array): Promise<void>;
}

/** Le magasin de l'appareil, clé par clé. */
export interface DeviceSaves {
	get(key: string): Promise<StampedSave | null>;
	put(key: string, save: StampedSave): Promise<void>;
}

export interface LocalSaveStoreOptions {
	folder: SaveFolder;
	device: DeviceSaves;
	now?: () => number;
}

const ALL_SLOTS: SaveSlot[] = ['sram', ...Array.from({ length: STATE_SLOTS }, (_, i) => i + 1)];

export function createLocalSaveStore(options: LocalSaveStoreOptions): LocalSaveStore {
	const { folder, device } = options;
	const now = options.now ?? (() => Date.now());

	/** La copie du dossier, s'il peut être lu sans rien demander. */
	async function fromFolder(checksum: string, slot: SaveSlot): Promise<StampedSave | null> {
		const facts = await folder.facts();
		if (!facts.supported || !facts.folder || !facts.readGranted) return null;
		const romFilename = await folder.romFilename(checksum);
		if (!romFilename) return null;
		return folder.readFile(saveFileName(romFilename, slot));
	}

	async function read(checksum: string, slot: SaveSlot): Promise<SaveRecord | null> {
		// Les deux sont lues, et une erreur de l'une ou l'autre remonte : sans
		// les deux, on ne sait pas laquelle est la plus récente, et c'est
		// exactement le cas où il ne faut pas écrire.
		const [inFolder, onDevice] = await Promise.all([
			fromFolder(checksum, slot),
			device.get(deviceSaveKey(checksum, slot))
		]);
		const newest = newestSave(inFolder, onDevice);
		return newest ? { ...newest.save, from: newest.from } : null;
	}

	async function write(checksum: string, slot: SaveSlot, bytes: Uint8Array): Promise<SaveWritten> {
		// Une copie : le tableau de l'appelant est souvent une vue sur la
		// mémoire du cœur, qui aura changé avant que l'écriture ne se fasse.
		const copy = bytes.slice();
		const facts = await folder.facts().catch(() => null);
		const romFilename = facts ? await folder.romFilename(checksum).catch(() => null) : null;
		const destination = facts
			? saveDestination({ ...facts, romFilename })
			: ({ kind: 'device', reason: 'no-folder' } as const);

		if (destination.kind === 'folder' && romFilename) {
			try {
				await folder.writeFile(saveFileName(romFilename, slot), copy);
				return { where: 'folder' };
			} catch {
				// Un dossier déplacé, un disque plein : l'appareil garde la
				// progression, et le panneau ROM reste l'endroit qui le dira.
				await device.put(deviceSaveKey(checksum, slot), { bytes: copy, savedAt: now() });
				return { where: 'device', reason: 'folder-failed' };
			}
		}

		await device.put(deviceSaveKey(checksum, slot), { bytes: copy, savedAt: now() });
		return { where: 'device', reason: destination.kind === 'device' ? destination.reason : 'not-in-folder' };
	}

	async function list(checksum: string): Promise<SaveListing[]> {
		const found: SaveListing[] = [];
		for (const slot of ALL_SLOTS) {
			// Une liste n'écrit rien : un emplacement illisible est simplement
			// absent de ce qu'on montre, il n'interdit rien.
			const record = await read(checksum, slot).catch(() => null);
			if (record) found.push({ slot, savedAt: record.savedAt, from: record.from });
		}
		return found;
	}

	return { read, write, list };
}

/* ------------------------------------------------------ pour les tests */

/** Un dossier en mémoire, pour les tests et pour qui ne veut rien persister. */
export function memorySaveFolder(init: {
	supported?: boolean;
	folder?: boolean;
	readGranted?: boolean;
	writeGranted?: boolean;
	roms?: Record<string, string>;
	now?: () => number;
}): SaveFolder & { files: Map<string, StampedSave> } {
	const files = new Map<string, StampedSave>();
	const now = init.now ?? (() => Date.now());
	return {
		files,
		async facts() {
			return {
				supported: init.supported ?? true,
				folder: init.folder ?? true,
				readGranted: init.readGranted ?? true,
				writeGranted: init.writeGranted ?? true
			};
		},
		async romFilename(checksum) {
			return init.roms?.[checksum] ?? null;
		},
		async readFile(name) {
			return files.get(name) ?? null;
		},
		async writeFile(name, bytes) {
			files.set(name, { bytes, savedAt: now() });
		}
	};
}

export function memoryDeviceSaves(): DeviceSaves & { entries: Map<string, StampedSave> } {
	const entries = new Map<string, StampedSave>();
	return {
		entries,
		async get(key) {
			return entries.get(key) ?? null;
		},
		async put(key, save) {
			entries.set(key, save);
		}
	};
}

/* ------------------------------------------------------- la production */

/** Le dossier que `local-library.ts` a mémorisé, par son handle. */
export function browserSaveFolder(): SaveFolder {
	const index = indexedDbFolderIndex();
	return {
		async facts() {
			const supported = supportsDirectoryPicker();
			if (!supported) {
				return { supported, folder: false, readGranted: false, writeGranted: false };
			}
			const handle = await storedDirectory();
			if (!handle) return { supported, folder: false, readGranted: false, writeGranted: false };
			// Interrogées, jamais demandées : une invite native au milieu d'une
			// partie est le tort, pas seulement le geste qu'elle exige. Le geste
			// qui accorde l'écriture vit sur le panneau ROM.
			const [readGranted, writeGranted] = await Promise.all([
				hasAccess(handle).catch(() => false),
				hasWriteAccess(handle)
			]);
			return { supported, folder: true, readGranted, writeGranted };
		},

		romFilename: (checksum) => index.filenameFor(checksum),

		async readFile(name) {
			const handle = await storedDirectory();
			if (!handle) return null;
			let file: File;
			try {
				file = await (await handle.getFileHandle(name)).getFile();
			} catch (err) {
				// Absent n'est pas illisible : un jeu jamais sauvegardé n'a pas de
				// `.srm`, et c'est le cas de chaque première partie.
				if ((err as { name?: string })?.name === 'NotFoundError') return null;
				throw err;
			}
			return { bytes: new Uint8Array(await file.arrayBuffer()), savedAt: file.lastModified };
		},

		async writeFile(name, bytes) {
			const handle = await storedDirectory();
			if (!handle) throw new Error('No folder to write into');
			const file = await handle.getFileHandle(name, { create: true });
			const writable = await (
				file as unknown as {
					createWritable(): Promise<{ write(d: Uint8Array): Promise<void>; close(): Promise<void> }>;
				}
			).createWritable();
			await writable.write(bytes);
			await writable.close();
		}
	};
}

/**
 * Sa propre base, et pas un store de plus dans `psnes-roms`.
 *
 * `local-library.ts` et `kept-files.ts` ouvrent `psnes-roms` et doivent tous
 * deux connaître sa version : un troisième module qui la monterait obligerait
 * les deux autres à suivre, et ouvrir en v2 après une v3 lève `VersionError`
 * en laissant le joueur sans bibliothèque. Une base à part n'a pas ce couplage.
 */
const DB_NAME = 'psnes-local';
/**
 * 2 depuis #71 : la file des sauvegardes, la mémoire de la dernière
 * synchronisation, et la bibliothèque vue en ligne. Ce module est le seul à
 * ouvrir cette base - la page comme le service worker passent par ici - donc
 * monter la version ne laisse personne derrière.
 *
 * 3 : les savestates gardés sur l'appareil (`local-states.ts`) - ceux pris
 * hors-ligne comme la copie de ceux du serveur, pour qu'une partie hors-ligne
 * retrouve ce qu'on a sauvegardé en ligne. Leurs octets à part de leur fiche :
 * lister les sauvegardes d'un jeu ne doit pas charger un mégaoctet par ligne.
 */
const DB_VERSION = 3;
const SAVES = 'saves';
/** checksum -> nom de fichier, pour les ROMs désignées une par une. */
export const TITLES = 'titles';
/** syncId -> écriture en attente du serveur (`outbox.ts`). */
export const OUTBOX = 'outbox';
/** `userId:checksum` -> ce que la dernière synchronisation a laissé (`SyncRecord`). */
export const SYNC_RECORDS = 'sync-records';
/** userId -> la bibliothèque de ce compte telle qu'elle a été vue en ligne. */
export const LIBRARY = 'library';
/** id local -> la fiche d'un savestate gardé sur l'appareil (`LocalStateMeta`). */
export const STATES = 'states';
/** id local -> ses octets. */
export const STATE_BYTES = 'state-bytes';

export function openLocalDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(SAVES)) db.createObjectStore(SAVES);
			if (!db.objectStoreNames.contains(TITLES)) db.createObjectStore(TITLES);
			if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX);
			if (!db.objectStoreNames.contains(SYNC_RECORDS)) db.createObjectStore(SYNC_RECORDS);
			if (!db.objectStoreNames.contains(LIBRARY)) db.createObjectStore(LIBRARY);
			if (!db.objectStoreNames.contains(STATES)) db.createObjectStore(STATES);
			if (!db.objectStoreNames.contains(STATE_BYTES)) db.createObjectStore(STATE_BYTES);
		};
		request.onsuccess = () => {
			const db = request.result;
			// Un onglet resté ouvert sur l'ancienne version ne doit pas bloquer la
			// montée de celui qui vient d'être déployé : il lâche la base, et la
			// rouvrira à la version nouvelle à sa prochaine opération.
			db.onversionchange = () => db.close();
			resolve(db);
		};
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error('Another tab is holding the saves database open'));
	});
}

export function indexedDbDeviceSaves(): DeviceSaves {
	return {
		async get(key) {
			const db = await openLocalDb();
			try {
				return await new Promise<StampedSave | null>((resolve, reject) => {
					const request = db.transaction(SAVES, 'readonly').objectStore(SAVES).get(key);
					request.onsuccess = () => resolve((request.result as StampedSave | undefined) ?? null);
					request.onerror = () => reject(request.error);
				});
			} finally {
				db.close();
			}
		},
		async put(key, save) {
			const db = await openLocalDb();
			try {
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction(SAVES, 'readwrite');
					tx.objectStore(SAVES).put(save, key);
					tx.oncomplete = () => resolve();
					tx.onerror = () => reject(tx.error);
				});
			} finally {
				db.close();
			}
		}
	};
}

let shared: LocalSaveStore | null = null;

/** Le magasin de cet appareil. Paresseux : IndexedDB n'existe pas sous node. */
export function localSaveStore(): LocalSaveStore {
	shared ??= createLocalSaveStore({ folder: browserSaveFolder(), device: indexedDbDeviceSaves() });
	return shared;
}
