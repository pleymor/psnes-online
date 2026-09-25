import { Server } from 'socket.io';
import type { Room } from '../types/index.js';
import { getFriendships } from '../services/friends.js';
import { onlinePlayers } from '../rooms/online-players.js';

/**
 * « Dans un salon », tel que le serveur le sait : le salon dont l'ami est
 * MEMBRE, et non plus celui qu'il a créé.
 *
 * La liste d'amis déduisait ce statut des salons qu'elle voyait passer, rangés
 * par `createdBy`. Or un salon survit au départ de son créateur : A crée,
 * B rejoint, A quitte - et A restait « dans un salon » chez tous ses amis,
 * puisqu'un salon créé par A existait encore. Dans l'autre sens, B, qui
 * n'avait rien créé, n'y apparaissait jamais. Le serveur tient la liste des
 * joueurs de chaque salon ; c'est donc lui qui dit où est chacun, et le client
 * se contente de l'afficher.
 *
 * Réduit à ce que la liste affiche. Le salon complet voyage toujours par
 * `room:update`, vers le même public qu'avant ; ceci n'en apprend pas plus.
 */
export interface FriendRoomPresence {
  roomId: string;
  gameTitle?: string;
  status: Room['status'];
}

/**
 * Ce qu'un ami de ce membre peut savoir de son salon, ou null.
 *
 * Null quand personne n'y est présent, pour la même raison que
 * `isRoomVisibleTo` : un salon ne meurt plus en se vidant, et sans cela un ami
 * resterait « dans un salon » toute la nuit dans un lobby que personne n'a
 * rouvert depuis la veille.
 */
export function presenceIn(room: Room): FriendRoomPresence | null {
  if (onlinePlayers(room).length === 0) return null;
  return { roomId: room.id, gameTitle: room.gameTitle, status: room.status };
}

/**
 * Le salon où se trouve `userId`, ou null.
 *
 * Le premier trouvé suffit : un joueur n'est jamais que dans un salon à la
 * fois (`leaveCurrentRoom`).
 */
export function roomPresenceOf(userId: string, rooms: Iterable<Room>): FriendRoomPresence | null {
  for (const room of rooms) {
    if (room.players.some(p => p.userId === userId)) return presenceIn(room);
  }
  return null;
}

/**
 * Dit aux amis de `userId` où il est désormais.
 *
 * Aux amis de ce membre-là, et à eux seuls - exactement le public de
 * `friend:statusChanged`. Un ami de l'hôte qui n'est pas celui de ce membre
 * n'apprend rien de lui.
 */
export async function publishRoomPresence(
  io: Server,
  userId: string,
  room: FriendRoomPresence | null,
  getUserSocket: (id: string) => string | undefined
) {
  for (const friendship of await getFriendships(userId)) {
    const friendId = friendship.initiatorId === userId ? friendship.receiverId : friendship.initiatorId;
    const socketId = getUserSocket(friendId);
    if (socketId) io.to(socketId).emit('friend:roomChanged', { userId, room });
  }
}
