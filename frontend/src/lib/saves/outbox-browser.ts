/**
 * Les ports de production de la file (`outbox.ts`) : IndexedDB, `fetch`, et
 * `navigator.locks`.
 *
 * À part de `outbox.ts` pour que celui-ci reste testable sous node, et sans
 * aucun import `$lib` pour que le service worker puisse s'en servir : c'est
 * lui qui vide la file par Background Sync quand aucun onglet n'est ouvert.
 */

import { toBase64, fromBase64 } from './base64.js';
import { openLocalDb, OUTBOX, SYNC_RECORDS } from './local-store.js';
import { createOutbox, type Lock, type Outbox, type OutboxStorage, type OutboxTransport } from './outbox.js';
import type { SyncOp, SyncRecord } from './sync-rules.js';

async function inStore<T>(
	store: string,
	mode: IDBTransactionMode,
	run: (s: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
	const db = await openLocalDb();
	try {
		return await new Promise<T | undefined>((resolve, reject) => {
			const tx = db.transaction(store, mode);
			const request = run(tx.objectStore(store));
			tx.oncomplete = () => resolve(request ? request.result : undefined);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

export function indexedDbOutboxStorage(): OutboxStorage {
	return {
		async all() {
			return ((await inStore<SyncOp[]>(OUTBOX, 'readonly', (s) => s.getAll())) ?? []) as SyncOp[];
		},
		async put(op) {
			await inStore(OUTBOX, 'readwrite', (s) => {
				s.put(op, op.id);
			});
		},
		async remove(id) {
			await inStore(OUTBOX, 'readwrite', (s) => {
				s.delete(id);
			});
		},
		async getRecord(key) {
			return ((await inStore<SyncRecord | undefined>(SYNC_RECORDS, 'readonly', (s) => s.get(key))) ??
				null) as SyncRecord | null;
		},
		async putRecord(key, record) {
			await inStore(SYNC_RECORDS, 'readwrite', (s) => {
				s.put(record, key);
			});
		}
	};
}

/**
 * Oublier ce qu'un compte a laissé sur cet appareil - sauf ses écritures en
 * attente.
 *
 * Appelé à la déconnexion : la mémoire des synchronisations de ce compte n'a
 * rien à faire sous la session du suivant. La file, elle, reste : ce sont des
 * sauvegardes que le serveur n'a pas encore, et la déconnexion n'est pas une
 * raison de les perdre. Elles portent leur `userId` et ne partiront que sous
 * la session de ce compte-là, ce que le serveur vérifie aussi.
 */
export async function forgetRecordsOf(userId: string): Promise<void> {
	await inStore(SYNC_RECORDS, 'readwrite', (s) => {
		s.delete(IDBKeyRange.bound(`${userId}:`, `${userId}:￿`));
	});
}

/** La route qui reçoit chaque sorte d'écriture. */
export function syncRequest(op: SyncOp): { method: string; path: string; body: Record<string, unknown> } {
	const checksum = encodeURIComponent(op.checksum);
	if (op.kind === 'sram') {
		return {
			method: 'PUT',
			path: `/api/sync/${checksum}/sram`,
			body: { syncId: op.id, userId: op.userId, sram: toBase64(op.bytes), base: op.base ?? null, savedAt: op.savedAt }
		};
	}
	return {
		method: 'POST',
		path: `/api/sync/${checksum}/states`,
		body: {
			syncId: op.id,
			userId: op.userId,
			name: op.name,
			data: toBase64(op.bytes),
			screenshot: op.screenshot ?? null,
			savedAt: op.savedAt,
			replaces: op.replaces ?? null
		}
	};
}

export function fetchTransport(fetcher: typeof fetch = fetch): OutboxTransport {
	return {
		async send(op) {
			const { method, path, body } = syncRequest(op);
			// Lève sans réponse : c'est ce que la file range en « injoignable ».
			const res = await fetcher(path, {
				method,
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
			if (json && typeof json.sram === 'string') {
				return { status: res.status, body: { ...json, sram: fromBase64(json.sram) } };
			}
			return { status: res.status, body: json as never };
		}
	};
}

/**
 * Le verrou que la page et le service worker partagent.
 *
 * Sans lui, un Background Sync qui se déclenche pendant qu'un onglet vide la
 * file enverrait deux fois la même écriture. Le `syncId` rendrait le second
 * envoi inoffensif, mais pas gratuit : un savestate fait un mégaoctet.
 * Là où `navigator.locks` manque, le verrou en mémoire de `outbox.ts` suffit
 * pour un seul contexte.
 */
export function webLock(): Lock | undefined {
	const locks = (globalThis as { navigator?: { locks?: { request: Function } } }).navigator?.locks;
	if (!locks) return undefined;
	return <T>(run: () => Promise<T>) =>
		locks.request('psnes-save-outbox', () => run()) as Promise<T>;
}

export function browserOutbox(options: { onChange?: () => void; fetcher?: typeof fetch } = {}): Outbox {
	return createOutbox({
		storage: indexedDbOutboxStorage(),
		transport: fetchTransport(options.fetcher),
		lock: webLock(),
		onChange: options.onChange
	});
}
