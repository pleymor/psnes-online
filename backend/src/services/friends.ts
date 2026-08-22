import { Server } from 'socket.io';
import { getDb } from '../db/sqlite.js';
import { listAcceptedFriendshipsFor, listAcceptedFriendshipsWithProfiles } from '../db/friendships.js';
import type { Friendship } from '../db/types.js';
import { cache } from '../utils/cache.js';

export async function getFriendships(userId: string): Promise<Friendship[]> {
  const cacheKey = `friendships:${userId}`;
  let friendships = cache.get<Friendship[]>(cacheKey);

  if (!friendships) {
    friendships = listAcceptedFriendshipsFor(getDb(), userId);
    cache.set(cacheKey, friendships, 30000); // Cache for 30 seconds
  }

  return friendships;
}

export async function notifyFriendsRoomStatusChanged(
  io: Server,
  userId: string,
  roomId: string,
  status: 'playing' | 'destroyed',
  getUserSocket: (id: string) => string | undefined
) {
  const friendships = await getFriendships(userId);

  friendships.forEach(friendship => {
    const friendId = friendship.initiatorId === userId ? friendship.receiverId : friendship.initiatorId;
    const friendSocketId = getUserSocket(friendId);

    if (friendSocketId) {
      io.to(friendSocketId).emit('friend:roomStatusChanged', {
        userId,
        roomId,
        status
      });
    }
  });
}

export async function notifyFriendsStatusChanged(
  io: Server,
  userId: string,
  online: boolean,
  getUserSocket: (id: string) => string | undefined
) {
  const friendships = await getFriendships(userId);

  friendships.forEach(friendship => {
    const friendId = friendship.initiatorId === userId ? friendship.receiverId : friendship.initiatorId;
    const friendSocketId = getUserSocket(friendId);

    if (friendSocketId) {
      io.to(friendSocketId).emit('friend:statusChanged', {
        userId,
        online
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
  displayName: string;
  avatar: string | null;
  email: string;
  online: boolean;
}

export async function getOnlineFriends(
  userId: string,
  presence: { socketFor(userId: string): string | undefined }
): Promise<OnlineFriend[]> {
  const friendships = listAcceptedFriendshipsWithProfiles(getDb(), userId);

  return friendships.map((friendship): OnlineFriend => {
    const friend = friendship.initiatorId === userId ? friendship.receiver : friendship.initiator;
    // Narrowed on purpose: the old query selected these four columns, and the
    // repository hands back the whole User. Spreading it here would put
    // googleId and the timestamps on the wire.
    return {
      id: friend.id,
      displayName: friend.displayName,
      avatar: friend.avatar,
      email: friend.email,
      online: presence.socketFor(friend.id) !== undefined
    };
  });
}
