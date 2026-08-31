import type { GroupRoom } from './game-click';

/**
 * Ce que fait le bouton « Salon » d'une carte de jeu.
 *
 * Trois réponses, et cette fonction est ce qui choisit entre elles - même
 * partage que `gameClick`, pour la même raison : une chaîne de conditions dans
 * un template cache sa troisième branche.
 */
export type RoomIntent =
	| { kind: 'create' }
	| { kind: 'reuse'; roomId: string }
	| { kind: 'blocked'; reason: 'playing' };

export function roomIntent(room: GroupRoom | null | undefined): RoomIntent {
	if (!room) return { kind: 'create' };

	// Le serveur refuse de changer le jeu d'un salon qui joue, donc ce clic
	// n'aurait nulle part où aller. La bannière offre déjà le retour au jeu.
	if (room.status !== 'waiting') return { kind: 'blocked', reason: 'playing' };

	// Ouvrir un second salon abandonnerait le premier, dont le lien a
	// peut-être déjà été partagé et ne mènerait plus à personne.
	return { kind: 'reuse', roomId: room.id };
}
