/**
 * Le guetteur, sa notification et son rapport — une fois pour les trois
 * présentations.
 *
 * Il y en avait deux copies identiques, dans `SoloRoom.svelte` et
 * `LockstepRoom.svelte`, et une troisième présentation qui n'en avait aucune :
 * `VrShell.svelte` passe par `rooms/lockstep-engine.ts`, donc un versus joué
 * en casque ne comptait pas et rien ne le disait. Un module, trois appelants,
 * et la prochaine présentation hérite du comportement au lieu de le recopier.
 *
 * Rien ici n'émet vers le cœur ni ne lit un store : les quatre ports sont
 * passés par l'appelant, ce qui rend la règle testable depuis `core/test` sous
 * node nu - et ce qui garantit que l'observateur reste en lecture seule, la
 * propriété dont dépend tout le reste.
 *
 * Réserve honnête sur la VR : la couverture y est juste par construction et
 * non par observation, #62 rapportant que le lancement d'une partie en casque
 * échoue en production.
 */

import { MatchObserver, watcherFor, type MatchVerdict } from './match-watch.js';
import type { PadMask } from '../znet/protocol.js';

export interface MatchRecorderPorts {
	/** Le checksum du jeu, ou null quand le salon n'en porte pas. */
	crc32: string | null | undefined;
	/**
	 * La mémoire du cœur, pas une copie. La vue n'est valable que jusqu'à
	 * l'appel suivant au cœur, d'où une fonction plutôt qu'un tableau.
	 */
	wram: () => Uint8Array;
	/** Dire le vainqueur au joueur. */
	announce: (verdict: MatchVerdict, score: readonly [number, number]) => void;
	/** Dire le vainqueur au serveur. */
	report: (verdict: MatchVerdict) => void;
}

export interface MatchRecorder {
	/** À appeler à chaque image, depuis le rappel de la session. */
	onFrame(frame: number, pad1: PadMask, pad2: PadMask): void;
}

/** Un enregistreur pour cette cartouche, ou null pour toute ROM non mesurée. */
export function createMatchRecorder(ports: MatchRecorderPorts): MatchRecorder | null {
	const watcher = ports.crc32 ? watcherFor(ports.crc32) : null;
	if (!watcher) return null;

	// Nommé plutôt que retourné directement, pour que la notification lise le
	// score sur l'observateur qui a produit le verdict et non sur ce que le
	// champ d'un composant contient au moment où elle part.
	const observer: MatchObserver = new MatchObserver({
		watcher,
		readWram: ports.wram,
		onVerdict: (verdict) => {
			// Une copie, pas la référence : `MatchObserver.score` rend son tableau
			// interne tel quel, et ce même tableau continue de changer aux combats
			// suivants. Un appelant qui garde le score reçu ici (un journal, un
			// test) doit voir celui du combat annoncé, pas celui du moment où il
			// regarde.
			ports.announce(verdict, [observer.score[0], observer.score[1]]);
			ports.report(verdict);
		}
	});

	return {
		onFrame(frame, pad1, pad2) {
			// `note` avant `observe` : un appui de cette image doit être compté
			// avant d'être jugé.
			observer.note(pad1, pad2);
			observer.observe(frame);
		}
	};
}
