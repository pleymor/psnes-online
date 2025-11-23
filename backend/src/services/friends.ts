import { Server } from 'socket.io';
import { prisma } from '../db/prisma.js';
import { cache } from '../utils/cache.js';

export async function getFriendships(userId: string) {
  const cacheKey = `friendships:${userId}`;
  let friendships = cache.get<any[]>(cacheKey);

  if (!friendships) {
    friendships = await prisma.friendship.findMany({
      where: {
        OR: [
          { initiatorId: userId },
          { receiverId: userId }
        ],
        status: 'accepted'
      }
    });
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

export async function getOnlineFriends(userId: string, userSockets: Map<string, string>): Promise<any[]> {
  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { initiatorId: userId },
        { receiverId: userId }
      ],
      status: 'accepted'
    },
    include: {
      initiator: {
        select: {
          id: true,
          displayName: true,
          avatar: true,
          email: true
        }
      },
      receiver: {
        select: {
          id: true,
          displayName: true,
          avatar: true,
          email: true
        }
      }
    }
  });

  return friendships.map(friendship => {
    const friend = friendship.initiatorId === userId ? friendship.receiver : friendship.initiator;
    return {
      ...friend,
      online: userSockets.has(friend.id)
    };
  });
}
