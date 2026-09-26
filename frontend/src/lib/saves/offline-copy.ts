/**
 * La copie hors-ligne des sauvegardes, branchée sur l'application.
 *
 * Trois choses, qui manquaient à #71 et faisaient que « sauvegardé en ligne »
 * voulait dire « introuvable hors-ligne » :
 *
 *  1. **écrire ici d'abord** - chaque savestate pris en ligne (menu, F2, VR)
 *     est rangé sur l'appareil avant de partir par la socket, qui reste le
 *     chemin du salon ; sans réponse, il part par la file, qui ne perd rien ;
 *  2. **rapatrier** - quand la bibliothèque se charge en ligne, ce que le
 *     serveur tient pour ce compte (savestates, sauvegardes gardées, SRAM) est
 *     copié sur l'appareil, et seulement ce qui a changé depuis la dernière
 *     fois : chaque version est datée par le serveur, la date suffit ;
 *  3. **servir le même menu hors-ligne** - `deviceSaves` donne à la partie
 *     sans salon les sauvegardes de l'appareil, sous la forme que le menu en
 *     ligne connaît déjà (`shelf.ts`).
 *
 * Les décisions sont dans `local-states.ts` (`mirrorPlan`) ; ceci n'est que
 * l'orchestration, vérifiée par Playwright.
 */

import { get } from 'svelte/store';
import type { Socket } from 'socket.io-client';
import { user } from '$lib/stores/user';
import { createLogger } from '$lib/utils/logger';
import { fromBase64 } from './base64';
import { localSaveStore } from './local-store';
import { STATE_SLOTS } from './local-rules';
import {
	localStates,
	mirrorPlan,
	type LocalStateMeta,
	type ServerSave
} from './local-states';
import { openSram } from './sram-sync';
import { queueState, reachable, saveOutbox, sramContext, sramDeps } from './sync';
import { deleteSave, type DeleteResult, type SaveSummary, type SavesResult } from './api';
import type { BlockedKey, DeviceSaveActions } from './shelf';

const logger = createLogger('OfflineCopy');

/* ------------------------------------------------------ 1. écrire ici d'abord */

/** Combien attendre `game:saved` avant de confier l'écriture à la file. */
const SOCKET_ANSWER_MS = 10_000;

/** Qui garde la copie : un compte, et la cartouche. Null : pas de copie possible. */
export function mirrorOf(checksum: string | null | undefined): { owner: string; checksum: string } | null {
	const account = get(user);
	if (!checksum || !account || account.isAnonymous) return null;
	return { owner: account.id, checksum };
}

/** La fiche de l'appareil qui copie cette sauvegarde du serveur, s'il y en a une. */
async function copyOf(owner: string, checksum: string, serverId: string): Promise<LocalStateMeta | null> {
	const all = await localStates().list(owner, checksum);
	return all.find((m) => m.serverId === serverId) ?? null;
}

/** Mettre une fiche de l'appareil dans la file du serveur. */
async function queueCopy(meta: LocalStateMeta): Promise<void> {
	if (!meta.owner) return;
	const bytes = await localStates().bytes(meta.id);
	if (!bytes) return;
	// L'écrasement voulu va avec : le serveur le fera s'il tient encore la
	// version que le joueur a vue, et gardera les deux sinon.
	const over = meta.supersedes ? await localStates().get(meta.supersedes) : null;
	const sent = await queueState({
		userId: meta.owner,
		checksum: meta.checksum,
		name: meta.name,
		bytes,
		screenshot: meta.screenshot,
		replaces:
			over?.serverId && over.serverUpdatedAt !== null
				? { id: over.serverId, updatedAt: over.serverUpdatedAt }
				: null
	});
	await localStates().queued(meta.id, sent.syncId);
	if (sent.saveId) await localStates().confirm(meta.id, sent.saveId, null);
}

export type SocketWrite = { ok: true; queued: boolean } | { ok: false };

/**
 * Écrire un savestate pris en ligne : sur l'appareil, puis par la socket.
 *
 * La socket reste le chemin, parce que c'est celui du salon - le serveur y
 * vérifie que le jeu du salon est bien au joueur. L'appareil vient avant, et
 * c'est tout le changement : la copie existe même si la socket ne répond
 * jamais. Trois issues :
 *
 *  - `game:saved` : la copie prend l'id du serveur ;
 *  - `error` : le serveur a refusé (pas votre jeu, par exemple) - la copie
 *    écrite pour cet envoi sort, rien d'autre ne bouge, comme avant ;
 *  - rien : la socket est morte en route. La copie part par la file, qui la
 *    rejouera jusqu'à un accusé - au pire une sauvegarde en double, jamais
 *    une de perdue.
 */
export async function writeThroughSocket(input: {
	socket: Socket | null;
	roomId: string;
	target?: { id: string; name: string } | null;
	name: string;
	saveData: string | undefined;
	screenshot: string | undefined;
	mirror: { owner: string; checksum: string } | null;
	timeoutMs?: number;
}): Promise<SocketWrite> {
	const { socket, roomId, target, name, saveData, screenshot, mirror } = input;

	let copy: LocalStateMeta | null = null;
	if (mirror && saveData) {
		try {
			const over = target ? await copyOf(mirror.owner, mirror.checksum, target.id) : null;
			copy = await localStates().write({
				owner: mirror.owner,
				checksum: mirror.checksum,
				name,
				bytes: fromBase64(saveData),
				screenshot: screenshot ?? null,
				over: over?.id ?? null
			});
		} catch (err) {
			// L'appareil a refusé (quota, navigation privée) : le serveur reste
			// un destinataire, l'écriture part quand même.
			logger.warn('the savestate could not be kept on this device', err);
		}
	}

	const toQueue = async (): Promise<SocketWrite> => {
		if (!copy) return { ok: false };
		try {
			await queueCopy(copy);
			return { ok: true, queued: true };
		} catch (err) {
			logger.warn('the savestate could not be queued; it stays on this device', err);
			return { ok: true, queued: true };
		}
	};

	if (!socket?.connected) return toQueue();

	const answer = await new Promise<{ saved: { saveId?: string; updatedAt?: number | null } } | { refused: true } | null>(
		(resolve) => {
			const timer = setTimeout(() => {
				socket.off('game:saved', onSaved);
				socket.off('error', onError);
				resolve(null);
			}, input.timeoutMs ?? SOCKET_ANSWER_MS);
			const onSaved = (payload: { saveId?: string; updatedAt?: number | null }) => {
				clearTimeout(timer);
				socket.off('error', onError);
				resolve({ saved: payload ?? {} });
			};
			const onError = () => {
				clearTimeout(timer);
				socket.off('game:saved', onSaved);
				resolve({ refused: true });
			};
			socket.once('game:saved', onSaved);
			socket.once('error', onError);
			socket.emit('game:save', { roomId, saveId: target?.id, name, saveData, screenshot });
		}
	);

	if (answer === null) return toQueue();
	if ('refused' in answer) {
		if (copy) await localStates().refused(copy.id).catch(() => undefined);
		return { ok: false };
	}
	if (copy && answer.saved.saveId) {
		await localStates()
			.confirm(copy.id, answer.saved.saveId, answer.saved.updatedAt ?? null)
			.catch((err) => logger.warn('the kept copy could not be marked as sent', err));
	}
	return { ok: true, queued: false };
}

/* ------------------------------------------------------------ 2. rapatrier */

/** Le résumé d'une sauvegarde tel que `/api/games` le rend. */
interface LibrarySave {
	id: string;
	name: string;
	kind?: 'state' | 'sram';
	screenshot: string | null;
	createdAt: string;
	updatedAt: string;
	syncId?: string | null;
}

interface LibraryGame {
	crc32?: string | null;
	saves?: LibrarySave[];
	sramUpdatedAt?: string | null;
}

function toServerSave(s: LibrarySave): ServerSave {
	return {
		id: s.id,
		name: s.name,
		kind: s.kind === 'sram' ? 'sram' : 'state',
		screenshot: s.screenshot ?? null,
		createdAt: Date.parse(s.createdAt),
		updatedAt: Date.parse(s.updatedAt),
		syncId: s.syncId ?? null
	};
}

async function download(checksum: string, save: ServerSave): Promise<Uint8Array> {
	const res = await fetch(`/api/sync/${encodeURIComponent(checksum)}/states/${encodeURIComponent(save.id)}`, {
		credentials: 'include'
	});
	if (!res.ok) throw new Error(`GET state answered ${res.status}`);
	const body = (await res.json()) as { data: string };
	return fromBase64(body.data);
}

let running: Promise<void> = Promise.resolve();

/**
 * Garder sur l'appareil ce que le serveur tient pour ce compte.
 *
 * Appelé à chaque chargement de la bibliothèque en ligne, sans l'attendre.
 * Une passe à la fois : deux chargements rapprochés se suivent au lieu de
 * télécharger deux fois la même chose.
 */
export function keepSavesForOffline(games: readonly LibraryGame[]): Promise<void> {
	const account = get(user);
	if (!account || account.isAnonymous || !reachable()) return running;
	const userId = account.id;
	running = running.then(() => mirrorLibrary(userId, games)).catch((err) => {
		logger.warn('the saves could not be kept for offline play', err);
	});
	return running;
}

async function mirrorLibrary(userId: string, games: readonly LibraryGame[]): Promise<void> {
	const pending = new Set((await saveOutbox().pending(userId)).map((op) => op.id));
	let fetched = 0;
	let failed = 0;
	for (const game of games) {
		const checksum = game.crc32;
		if (!checksum) continue;

		const server = (game.saves ?? []).map(toServerSave);
		const local = await localStates().all(userId, checksum);
		if (server.length > 0 || local.length > 0) {
			const plan = mirrorPlan(local, server, pending, Date.now());
			for (const lost of plan.queue) {
				await queueCopy(lost).catch((err) => logger.warn('a kept savestate could not be queued', err));
			}
			const done = await localStates().apply(userId, checksum, plan, (save) => download(checksum, save));
			fetched += done.fetched;
			failed += done.failed;
		}

		// La SRAM, par le chemin qui l'ouvre avant une partie : il envoie
		// d'abord ce que l'appareil a de plus, puis suit le serveur s'il a
		// avancé. Seulement quand la version du serveur n'est pas celle que
		// l'appareil a vue la dernière fois.
		const sramAt = game.sramUpdatedAt ? Date.parse(game.sramUpdatedAt) : null;
		if (sramAt !== null) {
			const record = await saveOutbox().record(userId, checksum).catch(() => null);
			if (record?.base !== sramAt) {
				await openSram(sramDeps(userId), sramContext(checksum, userId)).catch((err) =>
					logger.warn('the battery save could not be kept for offline play', err)
				);
			}
		}
	}
	if (fetched || failed) logger.info('saves kept for offline play', { fetched, failed });
}

/* ------------------------------------------- 3. le même menu, hors-ligne */

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function summaryOf(meta: LocalStateMeta): SaveSummary {
	return {
		id: meta.id,
		name: meta.name,
		slotNumber: 0,
		screenshot: meta.screenshot,
		createdAt: iso(meta.createdAt),
		updatedAt: iso(meta.updatedAt),
		kind: meta.kind
	};
}

const LEGACY_PREFIX = 'slot:';

/**
 * Les sauvegardes d'une partie hors de tout salon, pour le menu de toujours.
 *
 * Les fiches de l'appareil pour ce compte (ou sans compte), et les trois
 * emplacements `<rom>.stateN` de la version précédente, qui se chargent
 * encore : ils étaient la progression de quelqu'un.
 */
export function deviceSaves(options: {
	owner: string | null;
	checksum: string;
	/** Le nom d'un ancien emplacement, traduit par l'appelant. */
	slotLabel: (n: number) => string;
	/** L'état courant et sa vignette ; null si la machine ne tourne pas. */
	capture: () => Promise<{ bytes: Uint8Array; screenshot: string | null } | null>;
	/** Mettre ces octets dans la machine. */
	apply: (bytes: Uint8Array) => boolean;
	/** Remettre une sauvegarde de cartouche gardée, par le serveur. */
	restoreSram?: (serverId: string) => Promise<boolean>;
	/** Le serveur répond-il en ce moment. */
	connected: () => boolean;
	/** L'id du jeu sur le serveur, pour supprimer une sauvegarde du compte quand il répond. */
	gameId?: () => string | null;
}): DeviceSaveActions {
	const { owner, checksum } = options;
	/** Les fiches de la dernière liste : le menu demande, sans attendre, ce qu'il peut griser. */
	let listed = new Map<string, LocalStateMeta>();

	async function list(): Promise<SavesResult> {
		try {
			const metas = await localStates().list(owner, checksum);
			listed = new Map(metas.map((m) => [m.id, m]));
			const kept = metas.map(summaryOf);
			const legacy = (await localSaveStore().list(checksum))
				.filter((s) => typeof s.slot === 'number' && s.slot <= STATE_SLOTS)
				.map(
					(s): SaveSummary => ({
						id: `${LEGACY_PREFIX}${s.slot}`,
						name: options.slotLabel(s.slot as number),
						slotNumber: s.slot as number,
						screenshot: null,
						createdAt: iso(s.savedAt),
						updatedAt: iso(s.savedAt),
						kind: 'state',
						legacySlot: s.slot as number
					})
				);
			return { ok: true, saves: [...kept, ...legacy] };
		} catch (err) {
			logger.warn('the saves on this device could not be listed', err);
			return { ok: false, reason: 'failedToLoadSaves' };
		}
	}

	async function metaOf(save: SaveSummary): Promise<LocalStateMeta | null> {
		return save.legacySlot ? null : localStates().get(save.id);
	}

	function removeBlocked(save: SaveSummary): BlockedKey | null {
		if (save.legacySlot) return 'legacySlotKept';
		if (owner === null) return null;
		if (!(options.connected() && options.gameId?.())) return 'needsConnection';
		return listed.get(save.id)?.serverId ? null : 'saveNotSentYet';
	}

	async function remove(save: SaveSummary): Promise<DeleteResult> {
		if (removeBlocked(save)) return { ok: false, reason: 'failedToDelete' };
		const meta = await metaOf(save);
		if (!meta) return { ok: false, reason: 'failedToDelete' };
		if (owner !== null) {
			// Une sauvegarde du compte ne se supprime que là-bas : ici, elle
			// reviendrait à la prochaine bibliothèque. Pas encore envoyée, elle
			// n'a pas d'id à supprimer.
			const gameId = options.gameId?.();
			if (!meta.serverId || !gameId) return { ok: false, reason: 'failedToDelete' };
			const result = await deleteSave(gameId, meta.serverId);
			if (!result.ok) return result;
		}
		await localStates().remove(meta.id);
		return { ok: true };
	}

	async function write(target: SaveSummary | undefined, name: string): Promise<boolean> {
		const shot = await options.capture();
		if (!shot) return false;
		let meta: LocalStateMeta;
		try {
			meta = await localStates().write({
				owner,
				checksum,
				name,
				bytes: shot.bytes,
				screenshot: shot.screenshot,
				over: target && !target.legacySlot ? target.id : null
			});
		} catch (err) {
			logger.error('the savestate could not be written on this device', err);
			return false;
		}
		// Avec un compte, elle part aussi dans la file, et quittera l'appareil
		// au retour du réseau. Ne pas y arriver n'efface rien : la fiche reste
		// « à envoyer », et la prochaine bibliothèque en ligne l'y remettra.
		if (owner !== null) {
			void queueCopy(meta).catch((err) => logger.warn('the savestate could not be queued', err));
		}
		return true;
	}

	async function load(save: SaveSummary): Promise<boolean> {
		try {
			if (save.legacySlot) {
				const record = await localSaveStore().read(checksum, save.legacySlot);
				return record ? options.apply(record.bytes) : false;
			}
			const meta = await metaOf(save);
			if (!meta) return false;
			if (meta.kind === 'sram') {
				return meta.serverId && options.restoreSram && options.connected()
					? options.restoreSram(meta.serverId)
					: false;
			}
			const bytes = await localStates().bytes(meta.id);
			return bytes ? options.apply(bytes) : false;
		} catch (err) {
			logger.error('the savestate could not be read from this device', err);
			return false;
		}
	}

	return {
		shelf: {
			list,
			remove,
			removeBlocked,
			pickBlocked: (save) =>
				save.kind === 'sram' && !(options.connected() && options.restoreSram) ? 'needsConnection' : null,
			get note() {
				return owner !== null && !options.connected() ? ('savesOfflineNote' as const) : null;
			}
		},
		write,
		load
	};
}

/** La sauvegarde rapide de cette partie hors de tout salon : F2 et F4. */
export async function deviceQuickSave(owner: string | null, checksum: string): Promise<SaveSummary | null> {
	const meta = await localStates().quick(owner, checksum);
	return meta ? summaryOf(meta) : null;
}
