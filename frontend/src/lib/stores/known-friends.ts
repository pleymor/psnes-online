/**
 * Les amis d'un compte tels qu'ils étaient à sa dernière connexion, pour que
 * le tiroir Amis s'ouvre hors-ligne sur la même liste qu'en ligne.
 *
 * Hors-ligne, le tiroir n'invite personne et ne répond à rien : ses boutons y
 * sont éteints. Mais un tiroir vide dirait « tu n'as pas d'amis », ce qui est
 * faux, et ferait de l'écran hors-ligne un autre écran que celui d'en ligne.
 *
 * Pas dans le cache du service worker, pour la raison que
 * `games/library-snapshot.ts` donne pour la bibliothèque : `/api/friends` est
 * une réponse authentifiée. Une copie par compte, lue seulement pour le compte
 * retenu, oubliée à sa déconnexion. Elle ne garde que ce que la liste affiche -
 * l'identifiant, le pseudonyme, l'avatar et la date - jamais le statut en
 * ligne, qui hors-ligne ne vaut rien.
 *
 * Pures sur un `Storage` passé en argument, comme `offline-account.ts`, donc
 * testées sans navigateur.
 */

export interface KnownFriend {
	friendshipId: string;
	friendsSince: string | null;
	friend: { id: string; pseudo: string; discriminator?: string; avatar?: string | null };
}

const PREFIX = 'psnes.friends.';

type Listed = {
	friendshipId?: unknown;
	friendsSince?: unknown;
	friend?: { id?: unknown; pseudo?: unknown; discriminator?: unknown; avatar?: unknown } | null;
};

/** Ce que `/api/friends` a rendu, réduit à ce que le tiroir affiche. */
export function knownFriendsOf(listed: readonly Listed[]): KnownFriend[] {
	const kept: KnownFriend[] = [];
	for (const entry of listed) {
		const friend = entry?.friend;
		if (typeof entry?.friendshipId !== 'string' || typeof friend?.id !== 'string' || typeof friend.pseudo !== 'string') {
			continue;
		}
		kept.push({
			friendshipId: entry.friendshipId,
			friendsSince: typeof entry.friendsSince === 'string' ? entry.friendsSince : null,
			friend: {
				id: friend.id,
				pseudo: friend.pseudo,
				...(typeof friend.discriminator === 'string' ? { discriminator: friend.discriminator } : {}),
				avatar: typeof friend.avatar === 'string' ? friend.avatar : null
			}
		});
	}
	return kept;
}

export function rememberFriends(
	storage: Pick<Storage, 'setItem'> | null,
	userId: string,
	listed: readonly Listed[]
): void {
	try {
		storage?.setItem(PREFIX + userId, JSON.stringify(knownFriendsOf(listed)));
	} catch {
		// Stockage refusé : le tiroir hors-ligne sera vide, et le dira.
	}
}

export function readKnownFriends(storage: Pick<Storage, 'getItem'> | null, userId: string): KnownFriend[] {
	try {
		const raw = storage?.getItem(PREFIX + userId);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? knownFriendsOf(parsed) : [];
	} catch {
		return [];
	}
}

export function forgetKnownFriends(storage: Pick<Storage, 'removeItem'> | null, userId: string): void {
	try {
		storage?.removeItem(PREFIX + userId);
	} catch {
		// Rien à oublier.
	}
}
