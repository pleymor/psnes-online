import { Server } from 'socket.io';
import { getDb } from '../db/sqlite.js';
import { listAcceptedFriendshipsFor, listAcceptedFriendshipsWithProfiles } from '../db/friendships.js';
import { cache } from '../utils/cache.js';

export async function getFriendships(userId: string) {
  const cacheKey = `friendships:${userId}`;
  let friendships = cache.get<any[]>(cacheKey);

  if (!friendships) {
    friendships = listAcceptedFriendshipsFor(getDb(), userId);
    cache.set(cacheKey, friendships, 30000); // Cache for 30 seconds
  }

  return friendships;
}

export async function notifyFriendsAboutRoom(io: Server, userId: string, room: any, getUserSocket: (id: string) => string | undefined) {
  const friendships = await getFriendships(userId);

  friendships.forEach(friendship => {
    const friendId = friendship.initiatorId === userId ? friendship.receiverId : friendship.initiatorId;
    const friendSocketId = getUserSocket(friendId);

    if (friendSocketId) {
      io.to(friendSocketId).emit('friend:roomCreated', {
        userId,
        room
      });
    }
  });
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

export async function getOnlineFriends(
  userId: string,
  presence: { socketFor(userId: string): string | undefined }
): Promise<any[]> {
  const friendships = listAcceptedFriendshipsWithProfiles(getDb(), userId);

  return friendships.map(friendship => {
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
