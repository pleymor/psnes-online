/**
 * La file des sauvegardes qui attendent le serveur (#71).
 *
 * Durable - elle vit dans IndexedDB et survit à l'onglet fermé, au navigateur
 * redémarré, au train qui passe deux heures sous terre - et elle ne retire
 * une écriture que sur un 200. C'est toute la raison de ne pas passer par la
 * socket (§5) : une écriture émise sur une socket morte disparaît sans erreur,
 * alors qu'ici une écriture sans accusé reste dans la file, et l'envoi suivant
 * la rejoue sous le même `syncId`, que le serveur reconnaît.
 *
 * Les décisions sont dans `sync-rules.ts` ; ce module n'est que l'orchestration,
 * derrière trois ports - le stockage, le transport, l'horloge - pour que le cas
 * qui compte se teste : l'envoi parti pendant une coupure, dont personne n'a
 * accusé réception.
 *
 * Utilisé par la page ET par le service worker (Background Sync) : les deux
 * vident la même file, d'où le verrou.
 *
 * Aucun import `$lib` : `core/test` tourne sous node nu.
 */

import {
	backoff,
	enqueue as place,
	failureOf,
	pendingFor,
	sramAck,
	syncRecordKey,
	type SramAck,
	type SyncFailureReason,
	type SyncOp,
	type SyncRecord
} from './sync-rules.js';

export interface OutboxStorage {
	all(): Promise<SyncOp[]>;
	put(op: SyncOp): Promise<void>;
	remove(id: string): Promise<void>;
	getRecord(key: string): Promise<SyncRecord | null>;
	putRecord(key: string, record: SyncRecord): Promise<void>;
}

/** Ce que le serveur a répondu, décodé. Lève quand il n'a pas répondu du tout. */
export interface TransportAnswer {
	status: number;
	body: {
		reason?: string;
		outcome?: string;
		updatedAt?: number;
		sram?: Uint8Array | null;
		kept?: { id: string; savedAt: number } | null;
		saveId?: string;
	} | null;
}

export interface OutboxTransport {
	send(op: SyncOp): Promise<TransportAnswer>;
}

/** Une section critique partagée : `navigator.locks` entre la page et le worker. */
export type Lock = <T>(run: () => Promise<T>) => Promise<T>;

export interface OutboxOptions {
	storage: OutboxStorage;
	transport: OutboxTransport;
	now?: () => number;
	newId?: () => string;
	lock?: Lock;
	/** Après chaque changement de la file, pour que l'écran se mette à jour. */
	onChange?: () => void;
}

/** Ce qu'une vidange a fait, pour ceux qui attendaient un envoi précis. */
export interface DrainReport {
	sent: SyncOp[];
	failed: { op: SyncOp; reason: SyncFailureReason }[];
	/** Par voie : ce qu'un accusé de SRAM a appris. */
	sram: Map<string, SramAck>;
	/** Les écritures qu'un conflit a gardées à côté plutôt que perdues. */
	kept: { op: SyncOp; savedAt: number }[];
	/** Les savestates créés ou écrasés, par voie : leur id sur le serveur. */
	states: Map<string, string>;
}

export interface NewOp {
	userId: string;
	checksum: string;
	kind: 'sram' | 'state';
	bytes: Uint8Array;
	savedAt: number;
	base?: number | null;
	name?: string;
	screenshot?: string | null;
	replaces?: { id: string; updatedAt: number } | null;
}

export interface Outbox {
	/** Range une écriture. Rend l'écriture telle qu'elle est dans la file. */
	add(op: NewOp): Promise<SyncOp>;
	/** Envoie ce qui est dû pour ce compte. `force` ignore le recul après échec. */
	drain(userId: string, options?: { checksum?: string; force?: boolean }): Promise<DrainReport>;
	pending(userId: string): Promise<SyncOp[]>;
	record(userId: string, checksum: string): Promise<SyncRecord | null>;
	setRecord(userId: string, checksum: string, record: SyncRecord): Promise<void>;
}

/** Une file d'attente en mémoire : le verrou le plus simple qui sérialise. */
function memoryLock(): Lock {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(run: () => Promise<T>) => {
		const next = tail.then(run, run);
		tail = next.catch(() => undefined);
		return next;
	};
}

function randomId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createOutbox(options: OutboxOptions): Outbox {
	const { storage, transport } = options;
	const now = options.now ?? (() => Date.now());
	const newId = options.newId ?? randomId;
	const lock = options.lock ?? memoryLock();
	const changed = () => options.onChange?.();

	async function add(input: NewOp): Promise<SyncOp> {
		return lock(async () => {
			const id = newId();
			const op: SyncOp = {
				...input,
				// Une copie : l'appelant tient souvent une vue sur la mémoire du
				// cœur, qui aura changé avant que la file ne l'écrive.
				bytes: input.bytes.slice(),
				id,
				attempts: 0,
				notBefore: 0,
				lastError: null,
				rev: 0,
				lane: id
			};
			const before = await storage.all();
			const after = place(before, op);
			const placed = after.find((o) => o.id === op.id)!;
			// Ce que la fusion a remplacé sort de la file dans le même geste que
			// ce qui le remplace y entre : l'ordre est « écrire, puis retirer »,
			// pour qu'une coupure entre les deux laisse deux écritures et non
			// aucune.
			await storage.put(placed);
			for (const gone of before) {
				if (!after.some((o) => o.id === gone.id)) await storage.remove(gone.id);
			}
			changed();
			return placed;
		});
	}

	/** Relit une écriture par sa voie : une fusion a pu la remplacer pendant l'envoi. */
	async function current(lane: string): Promise<SyncOp | undefined> {
		return (await storage.all()).find((o) => o.lane === lane);
	}

	async function markFailed(op: SyncOp, reason: SyncFailureReason): Promise<void> {
		const live = await current(op.lane);
		// Remplacée pendant l'envoi : la nouvelle n'a pas échoué, elle n'est pas
		// encore partie.
		if (!live || live.rev !== op.rev) return;
		const attempts = live.attempts + 1;
		await storage.put({
			...live,
			attempts,
			notBefore: now() + backoff(attempts, reason),
			lastError: { reason, at: now() }
		});
	}

	async function drain(
		userId: string,
		opts: { checksum?: string; force?: boolean } = {}
	): Promise<DrainReport> {
		return lock(async () => {
			const report: DrainReport = { sent: [], failed: [], sram: new Map(), kept: [], states: new Map() };
			// Dans l'ordre où elles ont été jouées : IndexedDB rend les clés triées,
			// et les clés sont aléatoires.
			const due = pendingFor(await storage.all(), userId)
				.filter(
					(o) => (!opts.checksum || o.checksum === opts.checksum) && (opts.force || o.notBefore <= now())
				)
				.sort((a, b) => a.savedAt - b.savedAt);

			for (const op of due) {
				let answer: TransportAnswer;
				try {
					answer = await transport.send(op);
				} catch {
					// Pas de réponse : l'écriture reste, telle quelle, et celles qui
					// suivent échoueraient de même. Le prochain `connected` reprend.
					await markFailed(op, 'unreachable');
					report.failed.push({ op, reason: 'unreachable' });
					break;
				}

				if (answer.status !== 200 || !answer.body) {
					const reason = failureOf({ status: answer.status, reason: answer.body?.reason });
					await markFailed(op, reason);
					report.failed.push({ op, reason });
					// Une session expirée refusera tout le reste de la même façon.
					if (reason === 'session' || reason === 'unreachable') break;
					continue;
				}

				// Le 200 est la preuve de réception : c'est lui, et lui seul, qui
				// autorise à retirer l'écriture de la file.
				const live = await current(op.lane);
				if (live && live.rev === op.rev) await storage.remove(op.id);
				report.sent.push(op);

				if (op.kind === 'sram') {
					const ack = sramAck(op.bytes, {
						outcome: answer.body.outcome ?? '',
						updatedAt: answer.body.updatedAt ?? 0,
						sram: answer.body.sram ?? null,
						kept: answer.body.kept ?? null
					});
					report.sram.set(op.lane, ack);
					if (ack.adopt) {
						await storage.putRecord(syncRecordKey(op.userId, op.checksum), ack.record);
						// Ce qui a remplacé cette écriture pendant l'envoi en descend :
						// sa base est désormais la version que le serveur vient de poser.
						if (live && live.rev !== op.rev) {
							await storage.put({ ...live, base: ack.record.base });
						}
					}
				} else if (answer.body.saveId) {
					report.states.set(op.lane, answer.body.saveId);
				}
				const outcome = answer.body.outcome;
				if (answer.body.kept || outcome === 'keep-beside-quick' || outcome === 'take-quick') {
					report.kept.push({ op, savedAt: answer.body.kept?.savedAt ?? op.savedAt });
				}
			}

			if (due.length > 0) changed();
			return report;
		});
	}

	return {
		add,
		drain,
		pending: async (userId) => pendingFor(await storage.all(), userId),
		record: (userId, checksum) => storage.getRecord(syncRecordKey(userId, checksum)),
		setRecord: async (userId, checksum, record) => {
			await storage.putRecord(syncRecordKey(userId, checksum), record);
		}
	};
}

/* ------------------------------------------------------ pour les tests */

export function memoryOutboxStorage(): OutboxStorage & {
	ops: Map<string, SyncOp>;
	records: Map<string, SyncRecord>;
} {
	const ops = new Map<string, SyncOp>();
	const records = new Map<string, SyncRecord>();
	return {
		ops,
		records,
		async all() {
			return [...ops.values()];
		},
		async put(op) {
			ops.set(op.id, op);
		},
		async remove(id) {
			ops.delete(id);
		},
		async getRecord(key) {
			return records.get(key) ?? null;
		},
		async putRecord(key, record) {
			records.set(key, record);
		}
	};
}
