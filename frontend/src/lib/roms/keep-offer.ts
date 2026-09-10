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
import { registerGame } from './local-library.js';
import { romFileName } from './rom-file.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('KeepOffer');

export interface KeepOfferDeps {
	/**
	 * Ce que « garder » veut dire. Un seam, pour la raison que `readAndKeep`
	 * donne dans `provider.ts` : la vraie écriture veut IndexedDB, et sans
	 * paramètre la règle ne serait testable nulle part.
	 */
	keep?: (bytes: Uint8Array, title?: string) => Promise<string>;
	/** Si ce navigateur sait garder quoi que ce soit. */
	available?: () => boolean;
	/**
	 * Inscrire le jeu dans la bibliothèque du joueur.
	 *
	 * Garder n'écrivait que les octets, et c'était une demi-promesse : le
	 * fichier était sur l'appareil et le joueur n'avait aucune carte à
	 * cliquer, donc aucun moyen de lancer seul le jeu qu'il venait
	 * d'accepter. Signalé le 2026-09-10. `POST /api/games` est idempotent sur
	 * le checksum - il rend la ligne existante plutôt que d'en créer une
	 * seconde - donc accepter deux fois ne coûte rien.
	 */
	register?: (checksum: string, title: string) => Promise<void>;
}

export interface KeepOffer {
	/** Le checksum sur lequel la question porte, ou null s'il n'y a rien à demander. */
	asked: Readable<string | null>;
	/**
	 * Des octets viennent d'arriver de l'hôte.
	 *
	 * `title` vient du salon : un jeu reçu n'a pas de nom de fichier, et c'est
	 * la seule chose qui puisse nommer sa carte tant que le CRC32 n'a rien
	 * trouvé dans le catalogue.
	 */
	received(checksum: string, bytes: Uint8Array, title?: string): void;
	accept(): Promise<void>;
	decline(): void;
}

export function createKeepOffer(deps: KeepOfferDeps = {}): KeepOffer {
	const keep =
		deps.keep ??
		((bytes: Uint8Array, title?: string) => keepReceived(bytes, { title }));
	const available = deps.available ?? keptFilesAvailable;
	/*
	 * `registerGame` veut un nom de fichier, et un jeu reçu n'en a pas : les
	 * octets sont arrivés par la socket. Le titre du salon en tient lieu, ce
	 * qui donne une carte lisible même si le CRC32 ne trouve rien dans le
	 * catalogue - et quand il trouve, c'est le catalogue qui nomme la carte de
	 * toute façon.
	 */
	const register =
		deps.register ??
		((checksum: string, title: string) => registerGame(checksum, romFileName(title, checksum)));

	const asked = writable<string | null>(null);
	/** Les checksums pour lesquels le joueur a déjà tranché, dans un sens ou l'autre. */
	const answered = new Set<string>();
	let pending: { checksum: string; bytes: Uint8Array; title: string } | null = null;

	return {
		asked: { subscribe: asked.subscribe },

		received(checksum, bytes, title = '') {
			// Un navigateur sans magasin ne doit pas promettre de garder, et une
			// reconnexion retransfère la ROM : reposer la question à chaque fois
			// serait du harcèlement pour un refus déjà exprimé.
			if (!available() || answered.has(checksum)) return;
			pending = { checksum, bytes, title };
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
			await keep(offer.bytes, offer.title);

			// Les octets d'abord, la ligne ensuite : une bibliothèque qui
			// annonce un jeu dont le fichier n'est pas là serait pire que
			// l'inverse. Et l'échec est avalé comme celui de `keepQuietly`,
			// pour la même raison - la question est déjà refermée, donc rien
			// à l'écran ne pourrait le rapporter, et une promesse rejetée
			// ici remonterait en unhandled rejection dans une page qui joue.
			try {
				await register(offer.checksum, offer.title);
			} catch (err) {
				logger.warn('Kept the ROM but could not add it to the library', err);
			}
		},

		decline() {
			if (!pending) return;
			answered.add(pending.checksum);
			pending = null;
			asked.set(null);
		}
	};
}
