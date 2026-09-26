/**
 * Les savestates gardés sur l'appareil : ceux pris hors-ligne, et la copie de
 * ceux du serveur.
 *
 * #71 a fait de la SRAM une écriture locale d'abord, mais les savestates pris
 * en ligne partaient encore par la socket seule (`game:save`) : rien n'en
 * restait sur l'appareil, et une partie hors-ligne ne les retrouvait pas. Ici,
 * chaque savestate est écrit chez le joueur AVANT de partir vers le serveur,
 * et ceux que le serveur tenait déjà - écrits avant ce changement, ou sur un
 * autre appareil - sont rapatriés quand la bibliothèque se charge en ligne,
 * un par un, seulement quand ils ont changé.
 *
 * Pas le dossier de ROMs : les savestates n'y ont que trois emplacements
 * (`<rom>.state1`…), alors qu'un compte en a autant qu'il veut, nommés, avec
 * une vignette. Le dossier garde la SRAM, qui est le fichier que les autres
 * émulateurs relisent ; ceux-ci restent dans le navigateur, où leur format -
 * celui de notre cœur - n'intéresse personne d'autre.
 *
 * Deux règles de #71 tiennent ici :
 *
 *  - **jamais d'écrasement**. Écrire par-dessus une sauvegarde crée une fiche
 *    neuve qui *remplace* l'ancienne à l'écran (`supersedes`) ; l'ancienne
 *    n'est retirée que quand le serveur a confirmé l'écrasement. S'il a au
 *    contraire gardé les deux, les deux restent ici aussi ;
 *  - **une copie occupée n'est pas touchée**. Tant qu'une écriture locale
 *    n'est pas confirmée par le serveur, la copie du serveur ne la remplace
 *    pas, quelle que soit sa date.
 *
 * Aucun import `$lib` : `core/test` tourne sous node nu.
 */

import { openLocalDb, STATES, STATE_BYTES } from './local-store.js';

/** La fiche d'un savestate de l'appareil. Ses octets sont à part. */
export interface LocalStateMeta {
	/** Local, stable : ce que le menu désigne. */
	id: string;
	/** Le compte, ou null sans compte (#70). */
	owner: string | null;
	checksum: string;
	name: string;
	/** `sram` : une sauvegarde de cartouche que la synchronisation a gardée. */
	kind: 'state' | 'sram';
	screenshot: string | null;
	createdAt: number;
	updatedAt: number;
	/** L'id de cette sauvegarde sur le serveur, une fois qu'il l'a confirmée. */
	serverId: string | null;
	/** Le `updatedAt` du serveur que ces octets portent : c'est lui qu'on compare. */
	serverUpdatedAt: number | null;
	/** L'écriture de la file (`outbox.ts`) qui porte cette version, si elle y est passée. */
	syncId: string | null;
	/**
	 * Écrite ici, pas encore confirmée par le serveur, et dans aucune file :
	 * l'envoi par la socket est en vol, ou a été coupé par une fermeture
	 * d'onglet. La prochaine bibliothèque en ligne la met dans la file.
	 */
	unsent: boolean;
	/** La fiche que celle-ci remplace à l'écran, le temps que le serveur tranche. */
	supersedes: string | null;
}

/** Ce que le serveur dit d'une sauvegarde, dans la liste de la bibliothèque. */
export interface ServerSave {
	id: string;
	name: string;
	kind: 'state' | 'sram';
	screenshot: string | null;
	createdAt: number;
	updatedAt: number;
	syncId: string | null;
}

export interface LocalStateStorage {
	/** Toutes les fiches de ce compte pour ce jeu, sans les octets. */
	list(owner: string | null, checksum: string): Promise<LocalStateMeta[]>;
	get(id: string): Promise<LocalStateMeta | null>;
	bytes(id: string): Promise<Uint8Array | null>;
	/** Écrit la fiche, et les octets quand ils sont donnés - dans une seule transaction. */
	put(meta: LocalStateMeta, bytes?: Uint8Array): Promise<void>;
	remove(id: string): Promise<void>;
}

/** La sauvegarde rapide - le même sentinelle que `quick.ts`, que ce module ne peut pas importer. */
export const QUICK_STATE_NAME = '__quick__';

/** Combien de temps un envoi par la socket peut rester sans réponse avant d'être pris pour perdu. */
export const UNSENT_GRACE_MS = 60_000;

/* ------------------------------------------------------------ les règles */

/**
 * Une copie occupée : une écriture locale que le serveur n'a pas encore
 * confirmée. Rien de ce que dit le serveur ne la remplace.
 */
export function isBusy(meta: LocalStateMeta, pending: ReadonlySet<string>): boolean {
	return meta.unsent || (meta.syncId !== null && pending.has(meta.syncId));
}

/** Ce que le menu montre : les fiches qu'aucune autre ne remplace, les plus récentes d'abord. */
export function visibleStates(all: readonly LocalStateMeta[]): LocalStateMeta[] {
	const replaced = new Set(all.map((m) => m.supersedes).filter((id): id is string => id !== null));
	return all.filter((m) => !replaced.has(m.id)).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Ce qu'une passe de rattrapage doit faire pour un jeu. */
export interface MirrorPlan {
	/** À télécharger : nouvelle au serveur, ou changée là-bas. `into` : la fiche qu'elle remplace. */
	fetch: { save: ServerSave; into: string | null }[];
	/** Une fiche locale que le serveur a reçue : elle prend son id, sans rien retélécharger. */
	adopt: { id: string; serverId: string; serverUpdatedAt: number; name: string; kind: 'state' | 'sram' }[];
	/** Un nom changé là-bas sans que les octets bougent (une sauvegarde rapide gardée). */
	rename: { id: string; name: string; kind: 'state' | 'sram' }[];
	/** Des fiches à retirer : supprimées sur le serveur, ou remplacées et confirmées. */
	drop: string[];
	/** Des fiches qui ne remplacent plus rien : le serveur a gardé les deux. */
	release: string[];
	/** Des écritures locales qu'aucune file ne porte : à y mettre. */
	queue: LocalStateMeta[];
}

/**
 * Rapprocher ce que l'appareil garde de ce que le serveur tient, pour un jeu.
 *
 * `server` est la liste que `/api/games` vient de rendre - des résumés, sans
 * octets ; `pending`, les `syncId` encore dans la file. Seul ce qui manque ou
 * a changé est téléchargé : le serveur date chaque version, et une fiche qui
 * porte la même date porte les mêmes octets.
 */
export function mirrorPlan(
	local: readonly LocalStateMeta[],
	server: readonly ServerSave[],
	pending: ReadonlySet<string>,
	now: number
): MirrorPlan {
	const plan: MirrorPlan = { fetch: [], adopt: [], rename: [], drop: [], release: [], queue: [] };
	const busy = (m: LocalStateMeta) => isBusy(m, pending);
	const byServerId = new Map<string, LocalStateMeta>();
	const bySyncId = new Map<string, LocalStateMeta>();
	for (const m of local) {
		if (m.serverId) byServerId.set(m.serverId, m);
		if (m.syncId) bySyncId.set(m.syncId, m);
	}
	/** Les fiches dont le serveur a parlé : ce qui reste n'y est plus. */
	const seen = new Set<string>();

	for (const s of server) {
		// Envoyée d'ici par la file : le serveur a écrit ces octets-là, sous
		// cet id. Rien à télécharger - c'est la même version.
		const sent = s.syncId ? bySyncId.get(s.syncId) : undefined;
		if (sent && !busy(sent)) {
			seen.add(sent.id);
			if (sent.serverId !== s.id || sent.serverUpdatedAt !== s.updatedAt || sent.name !== s.name || sent.kind !== s.kind) {
				plan.adopt.push({ id: sent.id, serverId: s.id, serverUpdatedAt: s.updatedAt, name: s.name, kind: s.kind });
			}
			// L'ancienne copie de cet id, s'il y en avait une autre : la nouvelle
			// l'a remplacée là-bas, elle la remplace ici.
			const older = byServerId.get(s.id);
			if (older && older.id !== sent.id && !busy(older)) {
				seen.add(older.id);
				plan.drop.push(older.id);
			}
			continue;
		}

		const known = byServerId.get(s.id);
		if (!known) {
			plan.fetch.push({ save: s, into: null });
			continue;
		}
		seen.add(known.id);
		if (busy(known)) continue;
		if (known.serverUpdatedAt !== s.updatedAt) plan.fetch.push({ save: s, into: known.id });
		else if (known.name !== s.name || known.kind !== s.kind) {
			plan.rename.push({ id: known.id, name: s.name, kind: s.kind });
		}
	}

	const dropped = new Set(plan.drop);
	for (const m of local) {
		if (seen.has(m.id) || busy(m)) continue;
		// Confirmée autrefois, absente aujourd'hui : supprimée ailleurs, par le
		// joueur. La copie n'a plus rien à garder.
		if (m.serverId) {
			plan.drop.push(m.id);
			dropped.add(m.id);
		}
	}

	// Une écriture remplaçante est confirmée : l'ancienne sort si le serveur
	// l'a bien écrasée (même id), et revient à l'écran s'il a gardé les deux.
	const adopted = new Map(plan.adopt.map((a) => [a.id, a.serverId]));
	for (const m of local) {
		if (!m.supersedes || busy(m) || dropped.has(m.id)) continue;
		const serverId = adopted.get(m.id) ?? m.serverId;
		if (!serverId) continue;
		const old = local.find((o) => o.id === m.supersedes);
		if (!old) {
			plan.release.push(m.id);
			continue;
		}
		if (busy(old)) continue;
		const oldServerId = adopted.get(old.id) ?? old.serverId;
		// Même id : écrasée là-bas. Aucun id et absente du serveur : elle n'y est
		// jamais arrivée comme sauvegarde à part - la file l'a fondue dans celle
		// qui la remplace (la sauvegarde rapide, `enqueue`).
		if (oldServerId === serverId || (oldServerId === null && !seen.has(old.id))) {
			if (!dropped.has(old.id)) {
				plan.drop.push(old.id);
				dropped.add(old.id);
			}
		}
		plan.release.push(m.id);
	}

	for (const m of local) {
		// Un envoi par la socket qui n'a jamais répondu - l'onglet fermé en vol,
		// le réseau tombé. Il part par la file, qui, elle, ne perd rien.
		if (m.unsent && m.owner && now - m.updatedAt > UNSENT_GRACE_MS) plan.queue.push(m);
	}

	return plan;
}

/* ------------------------------------------------------------ le magasin */

export interface NewLocalState {
	owner: string | null;
	checksum: string;
	name: string;
	bytes: Uint8Array;
	screenshot: string | null;
	/** La fiche par-dessus laquelle on écrit, si c'en est une. */
	over?: string | null;
}

export interface LocalStates {
	/** Les fiches à montrer pour ce jeu, les plus récentes d'abord. */
	list(owner: string | null, checksum: string): Promise<LocalStateMeta[]>;
	get(id: string): Promise<LocalStateMeta | null>;
	bytes(id: string): Promise<Uint8Array | null>;
	/**
	 * Écrire un savestate. Une fiche neuve, toujours : par-dessus une autre,
	 * elle la remplace à l'écran sans l'effacer - sauf sans compte, où il n'y a
	 * aucun serveur pour trancher et où l'ancienne sort tout de suite.
	 */
	write(input: NewLocalState): Promise<LocalStateMeta>;
	/** Le serveur a confirmé : la fiche prend son id, et remplace pour de bon. */
	confirm(id: string, serverId: string, serverUpdatedAt: number | null): Promise<void>;
	/** Le serveur a refusé : la fiche écrite pour cet envoi sort, l'ancienne revient. */
	refused(id: string): Promise<void>;
	/** Elle est dans la file, sous ce `syncId`. */
	queued(id: string, syncId: string): Promise<void>;
	remove(id: string): Promise<void>;
	/** La sauvegarde rapide de ce jeu, s'il y en a une. */
	quick(owner: string | null, checksum: string): Promise<LocalStateMeta | null>;
	/** Appliquer une passe de rattrapage ; `download` va chercher les octets d'une sauvegarde. */
	apply(
		owner: string,
		checksum: string,
		plan: MirrorPlan,
		download: (save: ServerSave) => Promise<Uint8Array>
	): Promise<{ fetched: number; failed: number }>;
	/** Toutes les fiches de ce jeu, remplacées comprises : ce que la passe de rattrapage compare. */
	all(owner: string | null, checksum: string): Promise<LocalStateMeta[]>;
}

function randomId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createLocalStates(options: {
	storage: LocalStateStorage;
	now?: () => number;
	newId?: () => string;
}): LocalStates {
	const { storage } = options;
	const now = options.now ?? (() => Date.now());
	const newId = options.newId ?? randomId;

	async function write(input: NewLocalState): Promise<LocalStateMeta> {
		const at = now();
		const over = input.over ? await storage.get(input.over) : null;
		const meta: LocalStateMeta = {
			id: newId(),
			owner: input.owner,
			checksum: input.checksum,
			name: input.name,
			kind: 'state',
			screenshot: input.screenshot,
			createdAt: at,
			updatedAt: at,
			serverId: null,
			serverUpdatedAt: null,
			syncId: null,
			// Sans compte, il n'y a rien à envoyer : la fiche est réglée dès l'écriture.
			unsent: input.owner !== null,
			supersedes: over ? over.id : null
		};
		// Une copie : l'appelant tient souvent une vue sur la mémoire du cœur.
		await storage.put(meta, input.bytes.slice());
		if (over && input.owner === null) {
			await storage.remove(over.id);
			meta.supersedes = null;
			await storage.put(meta);
		}
		return meta;
	}

	async function confirm(id: string, serverId: string, serverUpdatedAt: number | null): Promise<void> {
		const meta = await storage.get(id);
		if (!meta) return;
		// L'écrasement par la socket est sans appel : ce que la fiche remplaçait
		// n'existe plus là-bas, sa copie non plus.
		if (meta.supersedes) {
			const old = await storage.get(meta.supersedes);
			if (old && (old.serverId === serverId || old.serverId === null)) await storage.remove(old.id);
		}
		await storage.put({ ...meta, serverId, serverUpdatedAt, unsent: false, supersedes: null });
	}

	async function refused(id: string): Promise<void> {
		await storage.remove(id);
	}

	async function queued(id: string, syncId: string): Promise<void> {
		const meta = await storage.get(id);
		if (!meta) return;
		await storage.put({ ...meta, syncId, unsent: false });
	}

	async function quick(owner: string | null, checksum: string): Promise<LocalStateMeta | null> {
		const shown = visibleStates(await storage.list(owner, checksum));
		return shown.find((m) => m.name === QUICK_STATE_NAME && m.kind === 'state') ?? null;
	}

	async function apply(
		owner: string,
		checksum: string,
		plan: MirrorPlan,
		download: (save: ServerSave) => Promise<Uint8Array>
	): Promise<{ fetched: number; failed: number }> {
		let fetched = 0;
		let failed = 0;
		for (const a of plan.adopt) {
			const meta = await storage.get(a.id);
			if (meta) {
				await storage.put({
					...meta,
					serverId: a.serverId,
					serverUpdatedAt: a.serverUpdatedAt,
					name: a.name,
					kind: a.kind
				});
			}
		}
		for (const r of plan.rename) {
			const meta = await storage.get(r.id);
			if (meta) await storage.put({ ...meta, name: r.name, kind: r.kind });
		}
		for (const { save, into } of plan.fetch) {
			let bytes: Uint8Array;
			try {
				bytes = await download(save);
			} catch {
				// Pas de copie cette fois ; la prochaine passe réessaiera, et
				// l'ancienne copie, s'il y en avait une, reste en place.
				failed++;
				continue;
			}
			const previous = into ? await storage.get(into) : null;
			await storage.put(
				{
					id: previous?.id ?? newId(),
					owner,
					checksum,
					name: save.name,
					kind: save.kind,
					screenshot: save.screenshot,
					createdAt: save.createdAt,
					updatedAt: save.updatedAt,
					serverId: save.id,
					serverUpdatedAt: save.updatedAt,
					syncId: save.syncId,
					unsent: false,
					supersedes: null
				},
				bytes
			);
			fetched++;
		}
		for (const id of plan.release) {
			const meta = await storage.get(id);
			if (meta) await storage.put({ ...meta, supersedes: null });
		}
		for (const id of plan.drop) await storage.remove(id);
		return { fetched, failed };
	}

	return {
		list: async (owner, checksum) => visibleStates(await storage.list(owner, checksum)),
		all: (owner, checksum) => storage.list(owner, checksum),
		get: (id) => storage.get(id),
		bytes: (id) => storage.bytes(id),
		write,
		confirm,
		refused,
		queued,
		remove: (id) => storage.remove(id),
		quick,
		apply
	};
}

/* ------------------------------------------------------ pour les tests */

export function memoryLocalStateStorage(): LocalStateStorage & {
	metas: Map<string, LocalStateMeta>;
	blobs: Map<string, Uint8Array>;
} {
	const metas = new Map<string, LocalStateMeta>();
	const blobs = new Map<string, Uint8Array>();
	return {
		metas,
		blobs,
		async list(owner, checksum) {
			return [...metas.values()].filter((m) => m.owner === owner && m.checksum === checksum);
		},
		async get(id) {
			return metas.get(id) ?? null;
		},
		async bytes(id) {
			return blobs.get(id) ?? null;
		},
		async put(meta, bytes) {
			metas.set(meta.id, { ...meta });
			if (bytes) blobs.set(meta.id, bytes);
		},
		async remove(id) {
			metas.delete(id);
			blobs.delete(id);
		}
	};
}

/* ------------------------------------------------------- la production */

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export function indexedDbLocalStateStorage(): LocalStateStorage {
	async function withDb<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
		const db = await openLocalDb();
		try {
			return await run(db);
		} finally {
			db.close();
		}
	}
	return {
		list: (owner, checksum) =>
			withDb(async (db) => {
				const all = (await result(
					db.transaction(STATES, 'readonly').objectStore(STATES).getAll()
				)) as LocalStateMeta[];
				return all.filter((m) => m.owner === owner && m.checksum === checksum);
			}),
		get: (id) =>
			withDb(async (db) => {
				const meta = await result(db.transaction(STATES, 'readonly').objectStore(STATES).get(id));
				return (meta as LocalStateMeta | undefined) ?? null;
			}),
		bytes: (id) =>
			withDb(async (db) => {
				const bytes = await result(db.transaction(STATE_BYTES, 'readonly').objectStore(STATE_BYTES).get(id));
				return (bytes as Uint8Array | undefined) ?? null;
			}),
		put: (meta, bytes) =>
			withDb(async (db) => {
				// Une transaction pour les deux : une fiche sans octets serait une
				// sauvegarde qu'on montre et qu'on ne peut pas charger.
				const tx = db.transaction([STATES, STATE_BYTES], 'readwrite');
				tx.objectStore(STATES).put(meta, meta.id);
				if (bytes) tx.objectStore(STATE_BYTES).put(bytes, meta.id);
				await done(tx);
			}),
		remove: (id) =>
			withDb(async (db) => {
				const tx = db.transaction([STATES, STATE_BYTES], 'readwrite');
				tx.objectStore(STATES).delete(id);
				tx.objectStore(STATE_BYTES).delete(id);
				await done(tx);
			})
	};
}

let shared: LocalStates | null = null;

/** Les savestates de cet appareil. Paresseux : IndexedDB n'existe pas sous node. */
export function localStates(): LocalStates {
	shared ??= createLocalStates({ storage: indexedDbLocalStateStorage() });
	return shared;
}
