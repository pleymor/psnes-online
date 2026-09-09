/**
 * Proposer à l'invité de garder la ROM que l'hôte vient de lui envoyer.
 *
 * `kept-files.ts` porte la règle : ce qu'un hôte envoie n'entre jamais dans le
 * magasin de lui-même, et la décision du 2026-09-08 est de DEMANDER. Seul
 * `VrShell.svelte` la tenait, sur son écran de lancement. Hors casque il n'y a
 * pas d'écran de lancement : la partie démarre dès que les octets arrivent, et
 * `remember` seul les laissait mourir avec l'onglet - l'invité redemandait le
 * même transfert à chaque partie.
 *
 * La question arrive donc APRÈS le transfert, à côté d'une partie qui tourne
 * déjà, et n'attend rien. La version VR pose la sienne avant, parce que là
 * c'était le moment gratuit ; ici l'inverse est vrai - lockstep ne va pas plus
 * vite que son pair le plus lent, et faire patienter DEUX joueurs pour une
 * question qui ne concerne qu'un appareil serait exactement ce que la VR
 * cherchait à éviter.
 *
 * Une fabrique plutôt qu'un store de module, comme `connection.ts` : deux
 * rooms ne coexistent pas, mais deux tests si.
 */

import { writable, type Readable } from 'svelte/store';

import { keepReceived } from './provider.js';
import { keptFilesAvailable } from './kept-files.js';

export interface KeepOfferDeps {
	/**
	 * Ce que « garder » veut dire. Un seam, pour la raison que `readAndKeep`
	 * donne dans `provider.ts` : la vraie écriture veut IndexedDB, et sans
	 * paramètre la règle ne serait testable nulle part.
	 */
	keep?: (bytes: Uint8Array) => Promise<string>;
	/** Si ce navigateur sait garder quoi que ce soit. */
	available?: () => boolean;
}

export interface KeepOffer {
	/** Le checksum sur lequel la question porte, ou null s'il n'y a rien à demander. */
	asked: Readable<string | null>;
	/** Des octets viennent d'arriver de l'hôte. */
	received(checksum: string, bytes: Uint8Array): void;
	accept(): Promise<void>;
	decline(): void;
}

export function createKeepOffer(deps: KeepOfferDeps = {}): KeepOffer {
	const keep = deps.keep ?? keepReceived;
	const available = deps.available ?? keptFilesAvailable;

	const asked = writable<string | null>(null);
	/** Les checksums pour lesquels le joueur a déjà tranché, dans un sens ou l'autre. */
	const answered = new Set<string>();
	let pending: { checksum: string; bytes: Uint8Array } | null = null;

	return {
		asked: { subscribe: asked.subscribe },

		received(checksum, bytes) {
			// Un navigateur sans magasin ne doit pas promettre de garder, et une
			// reconnexion retransfère la ROM : reposer la question à chaque fois
			// serait du harcèlement pour un refus déjà exprimé.
			if (!available() || answered.has(checksum)) return;
			pending = { checksum, bytes };
			asked.set(checksum);
		},

		async accept() {
			const offer = pending;
			if (!offer) return;
			// Noté avant l'écriture, et la question refermée tout de suite :
			// `keepQuietly` avale ses échecs par choix - « échouer à garder n'est
			// pas échouer à recevoir » - donc attendre pour savoir si ça a marché
			// laisserait le joueur devant une question sans réponse possible.
			pending = null;
			answered.add(offer.checksum);
			asked.set(null);
			await keep(offer.bytes);
		},

		decline() {
			if (!pending) return;
			answered.add(pending.checksum);
			pending = null;
			asked.set(null);
		}
	};
}
