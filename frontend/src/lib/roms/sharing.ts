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

import { writable, type Readable } from 'svelte/store';

export interface RomOffer {
	crc32: string;
	title: string;
	/** L'ami qui propose, tel que le relais le nomme. */
	from: string;
}

export interface SharingDeps {
	emit(event: string, payload: unknown): void;
	/** Les octets, si cet appareil les a déjà. */
	resolve(crc32: string): Promise<Uint8Array | null>;
	/** Attend le transfert, une fois la demande partie. */
	receive(crc32: string): Promise<Uint8Array>;
	/** Accepter, c'est avoir le jeu : garder les octets ET inscrire la fiche. */
	keep(bytes: Uint8Array, crc32: string, title: string): Promise<void>;
	send(to: string, bytes: Uint8Array): Promise<void>;
}

export interface Sharing {
	/** L'offre en attente de réponse sur CET appareil, ou null. */
	offered: Readable<RomOffer | null>;
	/** Le dump que ce joueur propose et dont il attend la réponse, ou null. */
	waiting: Readable<string | null>;

	offer(crc32: string, title: string): void;
	/** Le pair a refusé : l'attente s'arrête. */
	declined(): void;
	/** Le pair demande un dump - le sien, ou celui qu'on vient de lui offrir. */
	requested(from: string, crc32: string): Promise<void>;

	offerReceived(offer: RomOffer): Promise<void>;
	accept(): Promise<void>;
	decline(): void;
}

export function createSharing(deps: SharingDeps): Sharing {
	const offered = writable<RomOffer | null>(null);
	const waiting = writable<string | null>(null);
	let pending: RomOffer | null = null;

	return {
		offered: { subscribe: offered.subscribe },
		waiting: { subscribe: waiting.subscribe },

		offer(crc32, title) {
			waiting.set(crc32);
			deps.emit('rom:offer', { crc32, title });
		},

		declined() {
			waiting.set(null);
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
			// Celui qui offre ne sait pas ce que l'autre possède déjà. Poser la
			// question pour un jeu qui est là ferait répondre oui pour rien.
			if (await deps.resolve(offer.crc32)) return;
			pending = offer;
			offered.set(offer);
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
				const bytes = await deps.receive(offer.crc32);
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
			deps.emit('rom:offer-declined', { to: offer.from });
		}
	};
}
