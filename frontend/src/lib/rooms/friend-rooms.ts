/**
 * Le salon où se trouve chaque ami, tel que le serveur le dit.
 *
 * La liste d'amis le déduisait des salons qu'elle voyait passer, rangés par
 * leur CRÉATEUR : un salon créé par A et que A avait quitté gardait A « dans un
 * salon » chez tous ses amis, et B, qui n'avait rien créé, n'y apparaissait
 * jamais. Le serveur, qui tient la liste des joueurs de chaque salon, calcule
 * désormais le salon de chacun par appartenance (`backend/src/websocket/
 * friend-presence.ts`) ; ce magasin ne fait que l'afficher.
 *
 * Deux événements, et aucun autre :
 * - `friends:online`, réponse à `friends:getOnlineStatus`, porte le salon de
 *   chaque ami. C'est la réponse complète : elle remplace tout, et c'est ce qui
 *   reconstruit l'état après un rechargement.
 * - `friend:roomChanged`, à chaque fois que le salon d'un ami change - il y
 *   entre, en sort, on y choisit un jeu, une partie y commence.
 *
 * Écouté depuis le module et non depuis un composant, comme `my-room.ts` : un
 * changement qui arrive tiroir fermé n'est pas perdu pour autant.
 */
import { writable, type Readable } from 'svelte/store';
import { browser } from '$app/environment';
import type { Socket } from 'socket.io-client';
import { socket } from '$lib/api/socket';

/** Ce que le serveur dit du salon d'un ami - rien de plus. */
export interface FriendRoom {
	roomId: string;
	gameTitle?: string;
	status: 'waiting' | 'playing' | 'paused';
}

/** Une ligne de `friends:online`, réduite à ce qui intéresse ce magasin. */
export interface FriendStatus {
	id: string;
	room?: FriendRoom | null;
}

/** Réponse complète : l'état d'avant ne compte plus. */
export function fromFriendsOnline(list: FriendStatus[] | null | undefined): Map<string, FriendRoom> {
	const next = new Map<string, FriendRoom>();
	for (const friend of list ?? []) {
		if (friend?.room) next.set(friend.id, friend.room);
	}
	return next;
}

/** Un seul ami a changé ; les autres restent ce qu'ils étaient. */
export function withRoomChanged(
	map: Map<string, FriendRoom>,
	{ userId, room }: { userId: string; room: FriendRoom | null }
): Map<string, FriendRoom> {
	const next = new Map(map);
	if (room) next.set(userId, room);
	else next.delete(userId);
	return next;
}

const byFriend = writable<Map<string, FriendRoom>>(new Map());

/** userId -> le salon dont cet ami est membre. Absent : il n'est dans aucun. */
export const friendRooms: Readable<Map<string, FriendRoom>> = { subscribe: byFriend.subscribe };

let attachedTo: Socket | null = null;

function attach(sock: Socket) {
	if (attachedTo === sock) return;
	attachedTo = sock;
	sock.on('friends:online', (list: FriendStatus[]) => byFriend.set(fromFriendsOnline(list)));
	sock.on('friend:roomChanged', (payload: { userId: string; room: FriendRoom | null }) =>
		byFriend.update((map) => withRoomChanged(map, payload))
	);
}

if (browser) {
	socket.subscribe((sock) => {
		if (sock) {
			attach(sock);
			return;
		}
		attachedTo = null;
		byFriend.set(new Map());
	});
}
