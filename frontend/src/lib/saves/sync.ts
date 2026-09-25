/**
 * La synchronisation des sauvegardes, branchée sur l'application (#71).
 *
 * Tout ce qui décide est ailleurs - `sync-rules.ts`, `outbox.ts`,
 * `sram-sync.ts` ; ce fichier est ce qui les relie aux stores et au
 * navigateur, et il est donc vérifié à la main et par Playwright :
 *
 *  - **quand vider la file** : sur `connected`, et sur rien d'autre (§5). Un
 *    `online` du navigateur ne vide rien ; il fait re-demander `/auth/me` au
 *    layout, dont la réponse ouvre la socket, qui passe à `connected`. Et par
 *    Background Sync là où il existe, que le service worker traite lui-même ;
 *  - **ce que le joueur voit** : `syncStatus`, que le panneau ROM du profil et
 *    l'indicateur de la partie lisent. Une synchronisation silencieuse qui
 *    échoue est une perte qu'on découvre six mois plus tard (§7.3).
 */

import { derived, get, writable } from 'svelte/store';
import { user } from '$lib/stores/user';
import { linkState } from '$lib/stores/connection';
import { offlineAccount } from '$lib/stores/offline-account';
import { createLogger } from '$lib/utils/logger';
import { localSaveStore } from './local-store';
import { browserOutbox } from './outbox-browser';
import type { Outbox } from './outbox';
import { fromBase64 } from './base64';
import { shouldDrain, summarize, type SyncSummary } from './sync-rules';
import type { SramContext, SramSyncDeps } from './sram-sync';

const logger = createLogger('SaveSync');

/** Le compte dont on synchronise : celui de la session, ou celui dont on joue hors-ligne. */
export const syncUserId = derived([user, offlineAccount], ([$user, $offline]) =>
	$user && !$user.isAnonymous ? $user.id : ($offline?.id ?? null)
);

export interface SyncStatus extends SyncSummary {
	/** Des conflits tranchés depuis l'ouverture : combien de sauvegardes ont été gardées à côté. */
	kept: number;
	/** Une vidange est en cours. */
	draining: boolean;
}

export const syncStatus = writable<SyncStatus>({
	pending: 0,
	failure: null,
	stuck: false,
	kept: 0,
	draining: false
});

let shared: Outbox | null = null;

/** La file de cet appareil. Paresseuse : IndexedDB n'existe pas au prérendu. */
export function saveOutbox(): Outbox {
	shared ??= browserOutbox({ onChange: () => void refreshSyncStatus() });
	return shared;
}

export async function refreshSyncStatus(): Promise<void> {
	const userId = get(syncUserId);
	if (!userId) {
		syncStatus.update((s) => ({ ...s, pending: 0, failure: null, stuck: false }));
		return;
	}
	try {
		const summary = summarize(await saveOutbox().pending(userId));
		syncStatus.update((s) => ({ ...s, ...summary }));
	} catch (err) {
		logger.warn('the sync queue could not be read', err);
	}
}

/** Le serveur répond-il, là, maintenant - pour une session, pas pour `navigator.onLine`. */
function reachable(): boolean {
	return shouldDrain(get(linkState), !!get(user));
}

/**
 * Vider la file de ce compte.
 *
 * `force` ignore le recul après échec : c'est le bouton « Réessayer » du
 * panneau ROM, et le retour de la connexion, qui sont deux raisons de croire
 * que ça passera maintenant.
 */
export async function drainNow(options: { force?: boolean } = {}): Promise<void> {
	const userId = get(syncUserId);
	if (!userId || !reachable()) return;
	syncStatus.update((s) => ({ ...s, draining: true }));
	try {
		const report = await saveOutbox().drain(userId, { force: options.force });
		if (report.sent.length || report.failed.length) {
			logger.info('sync queue drained', {
				sent: report.sent.length,
				failed: report.failed.map((f) => f.reason),
				kept: report.kept.length
			});
		}
		if (report.kept.length) syncStatus.update((s) => ({ ...s, kept: s.kept + report.kept.length }));
	} catch (err) {
		logger.warn('the sync queue could not be drained', err);
	} finally {
		syncStatus.update((s) => ({ ...s, draining: false }));
		await refreshSyncStatus();
	}
}

/**
 * Demander au navigateur de vider la file au retour du réseau, même onglet
 * fermé. Là où Background Sync manque - Firefox, Safari - le retour de
 * `connected` et le prochain lancement de l'application s'en chargent.
 */
function requestBackgroundSync(): void {
	if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
	void navigator.serviceWorker.ready
		.then((registration) => {
			const sync = (registration as unknown as { sync?: { register(tag: string): Promise<void> } }).sync;
			return sync?.register(BACKGROUND_SYNC_TAG);
		})
		.catch(() => {
			// Refusé (permission, navigateur) : les deux autres déclencheurs restent.
		});
}

/** Le nom sous lequel le service worker reconnaît la demande. */
export const BACKGROUND_SYNC_TAG = 'psnes-saves';

async function fetchServerSram(checksum: string): Promise<{ bytes: Uint8Array | null; updatedAt: number | null }> {
	const res = await fetch(`/api/sync/${encodeURIComponent(checksum)}/sram`, { credentials: 'include' });
	// Une réponse qui n'est pas 200 n'est PAS « le serveur n'a rien » : c'est la
	// leçon de `saves/api.ts`, et `openSram` la traite en échec.
	if (!res.ok) throw new Error(`GET sram answered ${res.status}`);
	const body = (await res.json()) as { sram: string | null; updatedAt: number | null };
	return { bytes: body.sram ? fromBase64(body.sram) : null, updatedAt: body.updatedAt };
}

/** Ce que `openSram` et `persistSram` demandent, pour ce compte ou sans compte. */
export function sramDeps(userId: string | null): SramSyncDeps {
	return {
		store: localSaveStore(),
		outbox: userId ? saveOutbox() : null,
		fetchServer: fetchServerSram,
		reachable,
		kick: () => {
			requestBackgroundSync();
			void drainNow();
		},
		log: (message, detail) => logger.info(message, detail)
	};
}

export function sramContext(checksum: string, userId: string | null): SramContext {
	return { checksum, userId };
}

/**
 * Ranger un savestate pris par un joueur avec un compte, et l'envoyer si le
 * serveur est là. Rend l'id du savestate sur le serveur quand l'envoi a été
 * accusé tout de suite, null sinon - il est alors dans la file, pas perdu.
 */
export async function queueState(input: {
	userId: string;
	checksum: string;
	name: string;
	bytes: Uint8Array;
	screenshot: string | null;
	replaces?: { id: string; updatedAt: number } | null;
}): Promise<{ queued: true; saveId: string | null }> {
	const outbox = saveOutbox();
	const op = await outbox.add({
		userId: input.userId,
		checksum: input.checksum,
		kind: 'state',
		bytes: input.bytes,
		savedAt: Date.now(),
		name: input.name,
		screenshot: input.screenshot,
		replaces: input.replaces ?? null
	});
	requestBackgroundSync();
	if (!reachable()) return { queued: true, saveId: null };
	const report = await outbox.drain(input.userId, { checksum: input.checksum });
	await refreshSyncStatus();
	return { queued: true, saveId: report.states.get(op.lane) ?? null };
}

let started = false;

/**
 * Brancher les déclencheurs, une fois, depuis le layout.
 *
 * `connected` vide la file ; le changement de compte relit le compteur ; un
 * message du service worker (qui a vidé la file par Background Sync) aussi.
 */
export function startSaveSync(): void {
	if (started || typeof window === 'undefined') return;
	started = true;

	let previous = get(linkState);
	linkState.subscribe((state) => {
		const back = state === 'connected' && previous !== 'connected';
		previous = state;
		if (back) void drainNow({ force: true });
	});
	syncUserId.subscribe(() => {
		void refreshSyncStatus();
		// Le lancement de l'application est le troisième déclencheur : la socket
		// part `connected` par défaut et ne change donc pas d'état au premier
		// branchement, d'où la vidange à l'arrivée d'un compte.
		if (reachable()) void drainNow({ force: true });
	});
	navigator.serviceWorker?.addEventListener('message', (event) => {
		if ((event.data as { type?: string } | null)?.type === 'saves-synced') void refreshSyncStatus();
	});
}
