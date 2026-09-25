/**
 * Les décisions de la synchronisation, côté appareil (#71), sans navigateur.
 *
 * Le local fait autorité : le jeu écrit toujours chez lui, et le serveur est
 * un second destinataire, nourri par une file (`outbox.ts`). Tout ce qui
 * décide - faut-il envoyer, que faire d'une réponse, quand réessayer, que dire
 * au joueur - est ici en fonctions pures, pour la raison de `local-rules.ts` :
 * la collecte des faits demande IndexedDB et le réseau, et c'est précisément
 * la décision qui peut être fausse sans que personne le voie.
 *
 * La règle de fusion elle-même vit sur le serveur (`backend/src/saves/
 * sync-plan.ts`), le seul endroit qui voit les deux appareils. L'appareil ne
 * décide jamais qu'il a gagné : il envoie ce qu'il a, avec la version dont il
 * descend, et adopte ce qu'on lui répond.
 *
 * Aucun import `$lib` : `core/test` tourne sous node nu.
 */

/** La sauvegarde rapide - le même sentinelle que `quick.ts`, que ce module ne peut pas importer. */
export const QUICK_NAME = '__quick__';

/* ---------------------------------------------------------- la mémoire */

/**
 * Ce que cet appareil sait de la dernière synchronisation d'une cartouche,
 * pour un compte.
 *
 * `base` est le `sramUpdatedAt` du serveur à ce moment-là : la preuve, envoyée
 * avec la prochaine écriture, qu'elle descend de ce qui est stocké. `hash` est
 * l'empreinte des octets que le serveur tenait alors et que la copie locale
 * tenait aussi : une copie locale qui ne la porte plus a changé depuis - par
 * ce jeu, ou par RetroArch dans le `.srm` à côté de la ROM - et doit partir.
 * Les octets plutôt que la date : un fichier du dossier est daté par le
 * système, pas par nous.
 */
export interface SyncRecord {
	base: number | null;
	hash: string;
}

export function syncRecordKey(userId: string, checksum: string): string {
	return `${userId}:${checksum}`;
}

/** FNV-1a sur 32 bits : pas une sécurité, une étiquette pour « ce sont les mêmes octets ». */
export function bytesHash(bytes: Uint8Array): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < bytes.length; i++) {
		h ^= bytes[i];
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `${bytes.length}-${h.toString(16)}`;
}

export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
	if (!a || !b) return a === b;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * La copie locale a-t-elle quelque chose que le serveur n'a peut-être pas ?
 *
 * Sans mémoire pour ce compte, oui : cet appareil n'a jamais prouvé que sa
 * SRAM est sur le serveur. C'est le cas du joueur de #70 qui crée un compte, et
 * de celui qui copie un `.srm` dans son dossier. L'envoi part avec une `base`
 * nulle, que le serveur traite en conflit s'il a autre chose - les deux restent.
 */
export function localNeedsUpload(
	local: { bytes: Uint8Array } | null,
	record: SyncRecord | null
): boolean {
	if (!local || local.bytes.length === 0) return false;
	return !record || record.hash !== bytesHash(local.bytes);
}

/**
 * Au lancement, rien n'étant en attente : que faire de la copie du serveur ?
 *
 * `adopt` seulement quand la copie locale n'a rien à perdre : soit elle
 * n'existe pas, soit elle est exactement ce que le serveur tenait à la
 * dernière synchronisation (sans quoi elle serait partie dans la file, et on
 * n'en serait pas là). Le serveur a donc avancé depuis, par un autre appareil
 * qui descendait de la même version : c'est une suite, pas un conflit.
 */
export type OpenDecision =
	| { kind: 'keep-local' }
	| { kind: 'in-step'; record: SyncRecord }
	| { kind: 'adopt'; bytes: Uint8Array; record: SyncRecord };

export function openDecision(
	local: { bytes: Uint8Array } | null,
	server: { bytes: Uint8Array | null; updatedAt: number | null }
): OpenDecision {
	if (!server.bytes || server.updatedAt === null) return { kind: 'keep-local' };
	const record = { base: server.updatedAt, hash: bytesHash(server.bytes) };
	if (local && sameBytes(local.bytes, server.bytes)) return { kind: 'in-step', record };
	return { kind: 'adopt', bytes: server.bytes, record };
}

/* ---------------------------------------------------------- la file */

export interface SyncFailure {
	reason: SyncFailureReason;
	at: number;
}

export type SyncFailureReason =
	/** Pas de réponse : réseau, serveur, proxy. Réessayé. */
	| 'unreachable'
	/** La session a expiré : réessayé à la prochaine connexion. */
	| 'session'
	/** Le serveur a répondu 5xx. Réessayé. */
	| 'server'
	/** Le jeu n'est pas dans la bibliothèque de ce compte. */
	| 'not-in-library'
	/** Refusé tel quel : ne passera pas en réessayant. */
	| 'refused';

/** Une écriture en attente. Elle ne quitte la file que sur un 200. */
export interface SyncOp {
	/** Le `syncId` : ce qui rend l'envoi rejouable sans double. */
	id: string;
	userId: string;
	checksum: string;
	kind: 'sram' | 'state';
	bytes: Uint8Array;
	/** Quand l'appareil a écrit ces octets chez lui. */
	savedAt: number;
	/** SRAM : la version du serveur dont ces octets descendent. */
	base?: number | null;
	/** Savestate : son nom, sa vignette, et celui qu'il écrase s'il y en a un. */
	name?: string;
	screenshot?: string | null;
	replaces?: { id: string; updatedAt: number } | null;
	attempts: number;
	/** Pas avant ce moment : le recul après un échec. */
	notBefore: number;
	lastError: SyncFailure | null;
	/**
	 * Monte à chaque fusion. Un accusé reçu pour une révision antérieure ne
	 * retire pas l'écriture : elle a changé pendant le trajet.
	 */
	rev: number;
	/**
	 * Ce qui reste le même quand une écriture en remplace une autre dans la
	 * file : l'`id` change avec le contenu, la voie non. C'est par elle qu'un
	 * accusé retrouve ce qui a pris la place de ce qu'il accuse.
	 */
	lane: string;
}

/**
 * Ranger une nouvelle écriture dans la file.
 *
 * Deux écritures de SRAM de la même cartouche et du même compte n'en font
 * qu'une : la seconde descend de la première, sur le même appareil, et la
 * première n'a plus rien à apprendre au serveur. Elle garde la `base` de la
 * première - c'est la dernière version du serveur que l'appareil a vue, pas
 * celle que la première aurait produite.
 *
 * Même règle pour la sauvegarde rapide prise hors-ligne, qui est UNE sauvegarde
 * par jeu : F2 deux fois dans le train, c'est le joueur qui remplace la
 * sienne, pas la synchronisation qui perd quelque chose. Aucun autre savestate
 * n'est fusionné : chacun est une sauvegarde que le joueur a demandée.
 */
export function enqueue(queue: readonly SyncOp[], op: SyncOp): SyncOp[] {
	const mergeable = (o: SyncOp) =>
		o.userId === op.userId &&
		o.checksum === op.checksum &&
		o.kind === op.kind &&
		(op.kind === 'sram' || (op.name === QUICK_NAME && o.name === QUICK_NAME && !op.replaces));

	const index = queue.findIndex(mergeable);
	if (index === -1) return [...queue, op];
	const previous = queue[index];
	// L'identifiant est celui de la nouvelle écriture, pas de l'ancienne :
	// l'ancienne a peut-être déjà été écrite côté serveur pendant un envoi dont
	// l'accusé s'est perdu, et un envoi sous son `syncId` serait pris pour un
	// double et jeté.
	const merged: SyncOp = {
		...op,
		base: op.kind === 'sram' ? previous.base : op.base,
		replaces: previous.replaces ?? op.replaces ?? null,
		attempts: 0,
		notBefore: 0,
		lastError: null,
		rev: previous.rev + 1,
		lane: previous.lane
	};
	return queue.map((o, i) => (i === index ? merged : o));
}

/** Ce que ce compte a en attente, dans l'ordre d'envoi. */
export function pendingFor(queue: readonly SyncOp[], userId: string): SyncOp[] {
	return queue.filter((o) => o.userId === userId);
}

/** Une erreur qui ne se réglera pas en réessayant - dite au joueur, gardée quand même. */
export function isStuck(reason: SyncFailureReason): boolean {
	return reason === 'not-in-library' || reason === 'refused';
}

/**
 * Quand réessayer. Exponentiel, de 5 s à 10 min.
 *
 * Borné exprès : un train qui roule deux heures sans réseau ne doit pas
 * laisser au retour une file qui attend encore une heure. Et une file qui
 * échoue pour une raison qui ne passera pas (`isStuck`) attend le plafond : on
 * réessaie quand même, parce que le joueur peut avoir remis le jeu dans sa
 * bibliothèque entre-temps.
 */
export function backoff(attempts: number, reason: SyncFailureReason): number {
	if (isStuck(reason)) return 10 * 60_000;
	return Math.min(5000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000);
}

/** Ce qu'une réponse HTTP - ou son absence - veut dire pour la file. */
export function failureOf(outcome: { threw: true } | { status: number; reason?: string }): SyncFailureReason {
	if ('threw' in outcome) return 'unreachable';
	const { status } = outcome;
	if (status === 401) return 'session';
	if (status === 404 && outcome.reason === 'not-in-library') return 'not-in-library';
	if (status === 502 || status === 503 || status === 504) return 'unreachable';
	if (status >= 500) return 'server';
	return 'refused';
}

/**
 * Ce qu'un accusé de SRAM apprend à l'appareil.
 *
 * `adopt` : le serveur tient désormais les octets envoyés, à `updatedAt` - la
 * prochaine écriture en descendra. Sinon le serveur a gardé les siens (plus
 * récents) et les nôtres comme sauvegarde datée : l'appareil NE prend PAS la
 * nouvelle version pour base, parce que la partie qui tourne peut-être encore
 * ici continue la lignée perdante ; sa prochaine écriture sera un conflit de
 * plus, que la plus récente gagnera, et rien n'est perdu en route.
 */
export type SramAck =
	| { adopt: true; record: SyncRecord }
	| { adopt: false; server: Uint8Array | null; kept: boolean };

export function sramAck(
	sent: Uint8Array,
	response: { outcome: string; updatedAt: number; sram: Uint8Array | null; kept: unknown }
): SramAck {
	const serverHasOurs = response.sram === null || sameBytes(response.sram, sent);
	if (response.outcome !== 'stored-wins' && serverHasOurs) {
		return { adopt: true, record: { base: response.updatedAt, hash: bytesHash(sent) } };
	}
	return { adopt: false, server: response.sram, kept: response.kept !== null };
}

/* ---------------------------------------------------------- ce qu'on dit */

/** L'état de la synchronisation tel que le joueur le lit. */
export interface SyncSummary {
	/** Écritures pas encore reçues par le serveur. */
	pending: number;
	/** La dernière raison d'échec, si la file en porte une. */
	failure: SyncFailureReason | null;
	/** Au moins une écriture ne passera pas sans que le joueur fasse quelque chose. */
	stuck: boolean;
}

export function summarize(ops: readonly SyncOp[]): SyncSummary {
	const failing = ops
		.filter((o) => o.lastError)
		.sort((a, b) => b.lastError!.at - a.lastError!.at);
	return {
		pending: ops.length,
		failure: failing[0]?.lastError?.reason ?? null,
		stuck: ops.some((o) => o.lastError && isStuck(o.lastError.reason))
	};
}

/**
 * La clé de traduction de la ligne d'état.
 *
 * Une clé et pas une phrase, pour que le compilateur voie un renommage - la
 * même raison que `SaveNoteKey` dans `local-rules.ts`.
 */
export type SyncLineKey =
	| 'syncAllSent'
	| 'syncPending'
	| 'syncFailedUnreachable'
	| 'syncFailedSession'
	| 'syncFailedServer'
	| 'syncFailedNotInLibrary'
	| 'syncFailedRefused';

export function syncLineKey(summary: SyncSummary): SyncLineKey {
	if (summary.pending === 0) return 'syncAllSent';
	switch (summary.failure) {
		case null:
			return 'syncPending';
		case 'unreachable':
			return 'syncFailedUnreachable';
		case 'session':
			return 'syncFailedSession';
		case 'server':
			return 'syncFailedServer';
		case 'not-in-library':
			return 'syncFailedNotInLibrary';
		default:
			return 'syncFailedRefused';
	}
}

/**
 * Faut-il vider la file maintenant ?
 *
 * Sur `connected` et sur rien d'autre (#71 §5) : `navigator.onLine` répond vrai
 * sur un wifi de train qui ne mène nulle part, et une vidange lancée là
 * n'aurait que des échecs à compter. `online` sert à re-demander au serveur
 * s'il est là (`/auth/me`), et c'est cette réponse qui fait passer à
 * `connected`, donc à la vidange.
 */
export function shouldDrain(link: string, signedIn: boolean): boolean {
	return signedIn && link === 'connected';
}
