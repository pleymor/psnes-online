/**
 * Envoyer un de ses jeux à l'ami de son groupe, depuis la bibliothèque.
 *
 * Le transfert n'existait qu'à l'intérieur d'une partie : un invité sans le
 * fichier le recevait au lancement, et `roms/transfer.ts` porte encore cette
 * histoire. Partager était donc un effet de bord du lancement, et il arrivait
 * au seul moment où deux joueurs attendaient l'un sur l'autre - lockstep ne va
 * pas plus vite que son pair le plus lent. Le propriétaire a demandé le
 * 2026-09-10 de décorréler les deux : « permettre à un joueur de partager un
 * de ses jeux à son ami du groupe depuis la bibliothèque directement ».
 *
 * Un groupe EST un salon (`inGroup = players.length >= 2`), donc rien ne
 * change côté autorisation : les mêmes gardes d'appartenance portent l'offre,
 * et l'acceptation du destinataire est un `rom:request` ordinaire - c'est-à-
 * dire exactement le consentement que le relais exige avant de laisser passer
 * le moindre octet.
 *
 * Ce module ne porte que la conversation : qui offre, qui accepte, ce
 * qu'accepter veut dire. La socket, les octets et IndexedDB sont des seams,
 * pour la raison que `keep-offer.ts` donne pour les siens - et parce que
 * cette règle-ci est la première du transfert à être testable seule.
 */

import { get, writable, type Readable } from 'svelte/store';

export interface RomOffer {
	/**
	 * Le salon sur lequel l'offre est arrivée, et sur lequel on répond.
	 *
	 * Porté par l'offre plutôt que relu dans le store local, et c'est le
	 * correctif du 2026-09-10 : le serveur vient de valider l'appartenance
	 * avant de relayer, donc recouper avec ce que le client croit être « mon
	 * salon » n'ajoute qu'une façon de perdre le message - `my-room.ts`
	 * ignore délibérément `room:updated` et peut être en retard.
	 */
	roomId: string;
	crc32: string;
	title: string;
	/** L'ami qui propose, tel que le relais le nomme. */
	from: string;
}

export interface SharingDeps {
	/** Rend `false` quand rien n'est parti - pas de salon, pas de socket. */
	emit(event: string, payload: unknown): boolean;
	/**
	 * Les octets, si cet appareil les a déjà.
	 *
	 * Sert à sauter un transfert inutile, et NON à décider si la question se
	 * pose : voir `inLibrary`.
	 */
	resolve(crc32: string): Promise<Uint8Array | null>;
	/**
	 * Si ce jeu est déjà dans la bibliothèque du joueur.
	 *
	 * C'est ceci, et pas `resolve`, qui décide si la question vaut d'être
	 * posée. `resolveQuietly` répond « cet appareil peut-il ouvrir ce dump » -
	 * et il regarde le dossier de ROMs, qui peut contenir le fichier sans que
	 * psnes en sache rien. Le joueur dira sincèrement qu'il n'a pas le jeu, et
	 * supprimer la question lui refuse justement la fiche que le partage
	 * devait lui donner. Signalé le 2026-09-10.
	 */
	inLibrary(crc32: string): Promise<boolean>;
	/**
	 * Attend le transfert, une fois la demande partie.
	 *
	 * Le salon vient de l'offre, comme la réponse : la demande d'acceptation
	 * est elle aussi portée par le relais, et l'envoyer sur le mauvais salon
	 * la ferait jeter.
	 */
	receive(crc32: string, roomId: string): Promise<Uint8Array>;
	/** Accepter, c'est avoir le jeu : garder les octets ET inscrire la fiche. */
	keep(bytes: Uint8Array, crc32: string, title: string): Promise<void>;
	send(to: string, bytes: Uint8Array): Promise<void>;
}

export interface Sharing {
	/** L'offre en attente de réponse sur CET appareil, ou null. */
	offered: Readable<RomOffer | null>;
	/** Le dump que ce joueur propose et dont il attend la réponse, ou null. */
	waiting: Readable<string | null>;
	/**
	 * La dernière réponse reçue à une offre, ou null.
	 *
	 * `reason` vaut `'already-here'` quand l'ami a déjà le jeu, `'unreachable'`
	 * quand personne n'était joignable, et `null` pour un vrai « non merci ».
	 * Retenue parce que c'est la seule chose qui explique un écran resté vide
	 * chez l'autre, et que la personne qui en a besoin est celle qui attend.
	 */
	answer: Readable<{ crc32: string; reason: string | null } | null>;

	offer(crc32: string, title: string): void;
	/** Le pair a refusé : l'attente s'arrête, et la raison est retenue. */
	declined(reason?: string | null): void;
	/** Le pair demande un dump - le sien, ou celui qu'on vient de lui offrir. */
	requested(from: string, crc32: string): Promise<void>;

	/** Rend ce qui a été décidé, pour que l'appelant puisse le journaliser. */
	offerReceived(offer: RomOffer): Promise<'asked' | 'already-here'>;
	accept(): Promise<void>;
	decline(): void;
}

export function createSharing(deps: SharingDeps): Sharing {
	const offered = writable<RomOffer | null>(null);
	const waiting = writable<string | null>(null);
	const answer = writable<{ crc32: string; reason: string | null } | null>(null);
	let pending: RomOffer | null = null;

	return {
		offered: { subscribe: offered.subscribe },
		waiting: { subscribe: waiting.subscribe },
		answer: { subscribe: answer.subscribe },

		offer(crc32, title) {
			// La réponse d'avant s'effface : sinon « il a déjà ce jeu »
			// resterait affiché sous un bouton qui attend.
			answer.set(null);
			// L'attente seulement si la question est partie : hors groupe ou
			// sans socket, afficher « En attente de… » annonce une question
			// que personne n'a reçue.
			if (deps.emit('rom:offer', { crc32, title })) waiting.set(crc32);
		},

		declined(reason = null) {
			const crc32 = get(waiting);
			waiting.set(null);
			if (crc32) answer.set({ crc32, reason });
		},

		async requested(from, crc32) {
			const bytes = await deps.resolve(crc32);
			if (!bytes) {
				// Dire plutôt que se taire : sinon le demandeur attend le délai
				// d'expiration de `receiveRom` devant un écran muet.
				deps.emit('rom:unavailable', { to: from, reason: 'no-copy' });
				return;
			}
			try {
				await deps.send(from, bytes);
			} finally {
				waiting.set(null);
			}
		},

		async offerReceived(offer) {
			// Celui qui offre ne sait pas ce que l'autre a déjà. Poser la
			// question pour un jeu qui est dans sa bibliothèque ferait
			// répondre oui pour rien - mais se taire laissait l'offrant sur
			// « En attente de… » pour toujours, sans que personne puisse
			// savoir pourquoi.
			if (await deps.inLibrary(offer.crc32)) {
				deps.emit('rom:offer-declined', {
					roomId: offer.roomId,
					to: offer.from,
					reason: 'already-here'
				});
				return 'already-here';
			}
			pending = offer;
			offered.set(offer);
			return 'asked';
		},

		async accept() {
			const offer = pending;
			if (!offer) return;
			pending = null;
			// Refermée avant le transfert, pas après : la barre de progression
			// prend le relais, et une carte qui reste pendant l'envoi invite à
			// re-cliquer.
			offered.set(null);

			try {
				/*
				 * Les octets sont peut-être déjà là sans que le jeu soit dans
				 * la bibliothèque - le dossier de ROMs du joueur, typiquement.
				 * Il ne manque alors que la fiche, et faire traverser quatre
				 * mégaoctets au réseau pour l'obtenir serait absurde.
				 */
				const here = await deps.resolve(offer.crc32);
				const bytes = here ?? (await deps.receive(offer.crc32, offer.roomId));
				await deps.keep(bytes, offer.crc32, offer.title);
			} catch {
				// Rien n'est gardé à moitié, et l'ami peut reproposer. Le module
				// n'a pas le contexte qui rendrait un message lisible ; la page
				// qui l'appelle l'a.
			}
		},

		decline() {
			const offer = pending;
			if (!offer) return;
			pending = null;
			offered.set(null);
			deps.emit('rom:offer-declined', { roomId: offer.roomId, to: offer.from });
		}
	};
}
