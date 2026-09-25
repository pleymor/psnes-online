/**
 * La SRAM d'une partie, locale d'abord, pour tout le monde (#71 §7.2).
 *
 * Un seul chemin d'écriture : le jeu écrit dans le magasin local
 * (`local-store.ts`, à côté de la ROM ou dans ce navigateur), TOUJOURS, et
 * pour un joueur avec un compte l'écriture part ensuite dans la file
 * (`outbox.ts`) vers le serveur. Ce n'est pas un repli qui prend la main
 * quand le serveur tombe : c'est le chemin, en ligne comme hors-ligne.
 *
 * L'invariant de `SoloRoom.svelte` est renversé ici, et c'est le changement
 * central du ticket :
 *
 *  - **ne pas avoir pu lire le serveur devient normal**, et le jeu écrit quand
 *    même. Le serveur n'est plus la copie qu'on risque d'écraser : il reçoit,
 *    et c'est lui qui garde les deux côtés quand ils ont divergé ;
 *  - **ne pas avoir pu lire le local interdit toujours d'écrire**, pour la
 *    raison d'avant, déplacée : la SRAM vierge d'une ROM fraîchement chargée
 *    écraserait la vraie, et cette fois la vraie est chez le joueur.
 *
 * Le bug que `saves/api.ts` raconte - « je n'ai pas pu demander » pris pour
 * « il n'y en a pas » - ne revient pas par l'autre bout : une réponse du
 * serveur qu'on n'a pas eue n'est jamais traitée comme « le serveur n'a rien »,
 * elle laisse simplement la copie locale en place, et la file en attente.
 *
 * Aucun import `$lib` : `core/test` tourne sous node nu.
 */

import type { LocalSaveStore } from './local-store.js';
import type { Outbox } from './outbox.js';
import { bytesHash, localNeedsUpload, openDecision } from './sync-rules.js';

/** Quelle partie : une cartouche, et le compte qui la synchronise s'il y en a un. */
export interface SramContext {
	checksum: string;
	/** Null sans compte : le local, et rien d'autre (#70). */
	userId: string | null;
}

export interface SramSyncDeps {
	store: LocalSaveStore;
	/** Null sans compte. */
	outbox: Outbox | null;
	/** La SRAM du serveur et sa version. Lève si le serveur n'a pas répondu, ou mal. */
	fetchServer(checksum: string): Promise<{ bytes: Uint8Array | null; updatedAt: number | null }>;
	/** Le serveur vaut-il la peine d'être essayé maintenant (`linkState` connecté). */
	reachable(): boolean;
	/** Une vidange lancée sans l'attendre, après chaque écriture. */
	kick?(): void;
	now?: () => number;
	timeoutMs?: number;
	log?: (message: string, detail?: unknown) => void;
}

export type SramOpen =
	/**
	 * La SRAM à mettre dans la machine, et le droit de réécrire.
	 * `source` dit d'où viennent les octets ; `synced` si le serveur a été vu.
	 */
	| { ok: true; bytes: Uint8Array | null; source: 'local' | 'server'; synced: boolean }
	/** Le local n'a pas pu être lu : rien ne sera écrit de la session. */
	| { ok: false };

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timed out')), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

/**
 * Lire la SRAM avant la première image.
 *
 * Le local d'abord : c'est lui qui fait autorité, et un échec ici est le seul
 * qui interdise d'écrire. Puis, avec un compte et un serveur joignable,
 * rattraper ce que les autres appareils ont fait - en envoyant d'abord ce que
 * celui-ci a en attente, pour que le serveur, qui seul voit les deux côtés,
 * tranche avant qu'on ne démarre. Borné : un serveur lent ne retarde pas la
 * partie de plus de `timeoutMs`, et la partie démarre alors sur le local.
 */
export async function openSram(deps: SramSyncDeps, ctx: SramContext): Promise<SramOpen> {
	const log = deps.log ?? (() => {});
	let local: { bytes: Uint8Array; savedAt: number } | null;
	try {
		local = await deps.store.read(ctx.checksum, 'sram');
	} catch (err) {
		log('the local battery save could not be read', err);
		return { ok: false };
	}
	const localOnly: SramOpen = { ok: true, bytes: local?.bytes ?? null, source: 'local', synced: false };
	const { outbox, now = () => Date.now() } = deps;
	if (!ctx.userId || !outbox) return localOnly;
	const userId = ctx.userId;

	try {
		// La copie locale a peut-être changé sans nous - un `.srm` copié depuis
		// RetroArch, une partie jouée sans compte avant de s'inscrire. Elle part
		// dans la file comme n'importe quelle écriture : le serveur la gardera
		// quoi qu'il décide.
		const record = await outbox.record(userId, ctx.checksum);
		const queued = (await outbox.pending(userId)).some(
			(o) => o.checksum === ctx.checksum && o.kind === 'sram'
		);
		if (!queued && local && localNeedsUpload(local, record)) {
			await outbox.add({
				userId,
				checksum: ctx.checksum,
				kind: 'sram',
				bytes: local.bytes,
				savedAt: local.savedAt || now(),
				base: record?.base ?? null
			});
		}
	} catch (err) {
		// La file est un second destinataire : ne pas pouvoir y écrire ne doit
		// pas empêcher de jouer sur le local, qui fait autorité.
		log('the sync queue could not be read', err);
		return localOnly;
	}

	if (!deps.reachable()) return localOnly;

	const timeout = deps.timeoutMs ?? 5000;
	try {
		await withTimeout(outbox.drain(userId, { checksum: ctx.checksum, force: true }), timeout);
		const still = (await outbox.pending(userId)).some(
			(o) => o.checksum === ctx.checksum && o.kind === 'sram'
		);
		// Pas d'accusé : ce qui est ici n'est pas encore là-bas, et adopter la
		// copie du serveur l'écraserait. On joue sur le local.
		if (still) return localOnly;

		const server = await withTimeout(deps.fetchServer(ctx.checksum), timeout);
		const decision = openDecision(local, server);
		if (decision.kind === 'keep-local') return localOnly;
		if (decision.kind === 'in-step') {
			await outbox.setRecord(userId, ctx.checksum, decision.record);
			return { ...localOnly, synced: true };
		}
		// Le serveur a avancé - un autre appareil, ou le conflit que l'envoi
		// ci-dessus vient de trancher en faveur du plus récent, la nôtre gardée
		// là-bas comme sauvegarde datée. Le local le suit.
		await deps.store.write(ctx.checksum, 'sram', decision.bytes);
		await outbox.setRecord(userId, ctx.checksum, decision.record);
		log('the battery save was brought up to date from the server', { bytes: decision.bytes.length });
		return { ok: true, bytes: decision.bytes, source: 'server', synced: true };
	} catch (err) {
		log('the server could not be reached for the battery save; playing on the local copy', err);
		return localOnly;
	}
}

export type SramPersisted =
	| { ok: true; queued: boolean }
	| { ok: false };

/**
 * Écrire la SRAM : le local, puis la file.
 *
 * Rien n'est envoyé quand les octets sont ceux que le serveur tient déjà, ou
 * ceux qui attendent déjà dans la file : la minuterie de trente secondes
 * écrit même quand le joueur n'a rien sauvegardé en jeu, et une file qui
 * enflerait d'autant ferait mentir le compteur « N sauvegardes en attente ».
 */
export async function persistSram(
	deps: SramSyncDeps,
	ctx: SramContext,
	bytes: Uint8Array
): Promise<SramPersisted> {
	const log = deps.log ?? (() => {});
	const copy = bytes.slice();
	try {
		await deps.store.write(ctx.checksum, 'sram', copy);
	} catch (err) {
		log('the local battery save could not be written', err);
		return { ok: false };
	}
	const { outbox, now = () => Date.now() } = deps;
	if (!ctx.userId || !outbox) return { ok: true, queued: false };

	try {
		const hash = bytesHash(copy);
		const record = await outbox.record(ctx.userId, ctx.checksum);
		const queued = (await outbox.pending(ctx.userId)).find(
			(o) => o.checksum === ctx.checksum && o.kind === 'sram'
		);
		if (queued ? bytesHash(queued.bytes) === hash : record?.hash === hash) {
			return { ok: true, queued: !!queued };
		}
		await outbox.add({
			userId: ctx.userId,
			checksum: ctx.checksum,
			kind: 'sram',
			bytes: copy,
			savedAt: now(),
			base: record?.base ?? null
		});
		deps.kick?.();
		return { ok: true, queued: true };
	} catch (err) {
		// Le local a la progression ; la file réessaiera au prochain lancement,
		// puisque la copie locale ne portera pas l'empreinte synchronisée.
		log('the battery save could not be queued for the server', err);
		return { ok: true, queued: false };
	}
}
