import { Server } from 'socket.io';
import { getDb } from '../db/sqlite.js';
import { listAcceptedFriendshipsFor, listAcceptedFriendshipsWithProfiles } from '../db/friendships.js';
import type { Friendship } from '../db/types.js';
import { cache } from '../utils/cache.js';
import type { FriendRoomPresence } from '../websocket/friend-presence.js';

export async function getFriendships(userId: string): Promise<Friendship[]> {
  const cacheKey = `friendships:${userId}`;
  let friendships = cache.get<Friendship[]>(cacheKey);

  if (!friendships) {
    friendships = listAcceptedFriendshipsFor(getDb(), userId);
    cache.set(cacheKey, friendships, 30000); // Cache for 30 seconds
  }

  return friendships;
}

/**
 * `inVr` est un paramètre, et il n'est pas facultatif.
 *
 * `friend:statusChanged` a TROIS émetteurs, et quiconque en ajoute un quatrième
 * a besoin de la liste juste : celui-ci, `websocket/vr-lobby.ts` (l'entrée et
 * la sortie du lobby VR) et `api/friends.ts` (l'acceptation d'une demande
 * d'ami, qui annonce à chacun le statut de l'autre).
 *
 * Le client lit `payload.inVr` directement. Si cet émetteur-ci omettait le
 * champ, `undefined` serait faux et un ami bel et bien présent dans le lobby VR
 * en sortirait chez ses amis au premier changement de statut sans rapport. Les
 * trois émetteurs doivent donc produire la même forme, et un paramètre requis
 * est ce qui empêche un appelant de l'oublier - là où les deux autres
 * construisent des littéraux, que rien ne contraint.
 */
export async function notifyFriendsStatusChanged(
  io: Server,
  userId: string,
  online: boolean,
  inVr: boolean,
  getUserSocket: (id: string) => string | undefined
) {
  const friendships = await getFriendships(userId);

  friendships.forEach(friendship => {
    const friendId = friendship.initiatorId === userId ? friendship.receiverId : friendship.initiatorId;
    const friendSocketId = getUserSocket(friendId);

    if (friendSocketId) {
      io.to(friendSocketId).emit('friend:statusChanged', {
        userId,
        online,
        inVr
      });
    }
  });
}

/**
 * The exact wire shape of getOnlineFriends. Typed narrowly on purpose: with
 * the map callback below annotated to return OnlineFriend, TypeScript's
 * excess-property check catches a stray extra field or a typo'd field name
 * written out explicitly here. It does NOT catch `{ ...friend, online }` -
 * TypeScript exempts spread properties from excess-property checking, so a
 * regression to spreading the full User back in still compiles silently.
 * That specific mistake is caught only by keeping the explicit field list,
 * not by this type; see the comment on the return statement for why the
 * explicit list matters.
 */
export interface OnlineFriend {
  id: string;
  pseudo: string;
  discriminator: string;
  avatar: string | null;
  online: boolean;
  inVr: boolean;
  /** Le salon dont l'ami est membre, ou null - voir `websocket/friend-presence.ts`. */
  room: FriendRoomPresence | null;
}

export async function getOnlineFriends(
  userId: string,
  presence: { socketFor(userId: string): string | undefined },
  vr: { isInVr(userId: string): boolean },
  rooms: { roomOf(userId: string): FriendRoomPresence | null }
): Promise<OnlineFriend[]> {
  const friendships = listAcceptedFriendshipsWithProfiles(getDb(), userId);

  return friendships.map((friendship): OnlineFriend => {
    const friend = friendship.initiatorId === userId ? friendship.receiver : friendship.initiator;
    // Still written out field by field, even though the repository now hands
    // back a PublicUser rather than a whole User. The narrowing at the source
    // is the guarantee; this list is what keeps the wire shape stated in one
    // readable place, and what makes the excess-property check above bite.
    return {
      id: friend.id,
      pseudo: friend.pseudo,
      discriminator: friend.discriminator,
      avatar: friend.avatar,
      online: presence.socketFor(friend.id) !== undefined,
      inVr: vr.isInVr(friend.id),
      room: rooms.roomOf(friend.id)
    };
  });
}
