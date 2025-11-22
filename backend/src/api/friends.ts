import { Router } from 'express';
import { User } from '../types/index.js';
import { getIO, getUserSocket } from '../websocket/index.js';
import { prisma } from '../db/prisma.js';
import { cache } from '../utils/cache.js';

export const friendsRouter = Router();

// Middleware to check authentication
const requireAuth = (req: any, res: any, next: any) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
};

friendsRouter.use(requireAuth);

// Debug middleware to log all requests to friends routes
friendsRouter.use((req, res, next) => {
  console.log('📍 [FRIENDS ROUTER] Request:', req.method, req.path, 'Query:', req.query);
  next();
});

// Get all friends (accepted friendships)
friendsRouter.get('/', async (req, res) => {
  const user = req.user as User;
  console.log('📍 [FRIENDS ROUTER] GET / - Fetching friends for user:', user.id);

  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { initiatorId: user.id },
        { receiverId: user.id }
      ],
      status: 'accepted'
    },
    include: {
      initiator: true,
      receiver: true
    }
  });

  // Return friendship data with friend info and dates
  const friendsData = friendships.map(f => ({
    friendshipId: f.id,
    friend: f.initiatorId === user.id ? f.receiver : f.initiator,
    friendsSince: f.updatedAt, // When the friendship was accepted
    createdAt: f.createdAt
  }));

  res.json(friendsData);
});

// Get pending friend requests
friendsRouter.get('/requests', async (req, res) => {
  const user = req.user as User;

  const requests = await prisma.friendship.findMany({
    where: {
      receiverId: user.id,
      status: 'pending'
    },
    include: {
      initiator: true
    }
  });

  res.json(requests);
});

// Search users (for friend suggestions)
friendsRouter.get('/search', async (req, res) => {
  console.log('🔍 [FRIENDS SEARCH] Route hit! Query:', req.query);
  const user = req.user as User;
  const { query } = req.query;

  if (!query || typeof query !== 'string' || query.trim().length < 2) {
    console.log('🔍 [FRIENDS SEARCH] Query too short or invalid:', query);
    return res.json([]);
  }

  console.log('🔍 [FRIENDS SEARCH] Searching for:', query);

  const searchQuery = query.trim();

  // Find users matching the query (by email or display name)
  const users = await prisma.user.findMany({
    where: {
      AND: [
        { id: { not: user.id } }, // Exclude current user
        {
          OR: [
            { email: { contains: searchQuery } },
            { displayName: { contains: searchQuery } }
          ]
        }
      ]
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatar: true
    },
    take: 10 // Limit to 10 results
  });

  // Get existing friendships to filter out already connected users
  const friendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { initiatorId: user.id },
        { receiverId: user.id }
      ]
    },
    select: {
      initiatorId: true,
      receiverId: true,
      status: true
    }
  });

  const friendIds = new Set(
    friendships.map(f => f.initiatorId === user.id ? f.receiverId : f.initiatorId)
  );

  // Filter out users who are already friends or have pending requests
  const availableUsers = users.filter(u => !friendIds.has(u.id));

  console.log('🔍 [FRIENDS SEARCH] Found', availableUsers.length, 'available users');
  res.json(availableUsers);
});

// Send friend request
friendsRouter.post('/request', async (req, res) => {
  const user = req.user as User;
  const { friendEmail, friendId } = req.body;

  let friend;

  // Search by ID first if provided, otherwise by email
  if (friendId) {
    friend = await prisma.user.findUnique({
      where: { id: friendId }
    });
  } else if (friendEmail) {
    friend = await prisma.user.findUnique({
      where: { email: friendEmail }
    });
  }

  if (!friend) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (friend.id === user.id) {
    return res.status(400).json({ error: 'Cannot add yourself as friend' });
  }

  // Check if friendship already exists
  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { initiatorId: user.id, receiverId: friend.id },
        { initiatorId: friend.id, receiverId: user.id }
      ]
    }
  });

  if (existing) {
    return res.status(400).json({ error: 'Friendship already exists' });
  }

  const friendship = await prisma.friendship.create({
    data: {
      initiatorId: user.id,
      receiverId: friend.id,
      status: 'pending'
    },
    include: {
      initiator: true,
      receiver: true
    }
  });

  // Notify receiver via WebSocket
  const io = getIO();
  const receiverSocketId = getUserSocket(friend.id);
  if (io && receiverSocketId) {
    io.to(receiverSocketId).emit('friend:requestReceived', friendship);
  }

  res.json(friendship);
});

// Accept friend request
friendsRouter.post('/accept/:friendshipId', async (req, res) => {
  const user = req.user as User;
  const { friendshipId } = req.params;

  const friendship = await prisma.friendship.findUnique({
    where: { id: friendshipId }
  });

  if (!friendship || friendship.receiverId !== user.id) {
    return res.status(404).json({ error: 'Friend request not found' });
  }

  const updated = await prisma.friendship.update({
    where: { id: friendshipId },
    data: { status: 'accepted' },
    include: {
      initiator: true,
      receiver: true
    }
  });

  // Invalidate friendship cache for both users
  cache.delete(`friendships:${updated.initiatorId}`);
  cache.delete(`friendships:${updated.receiverId}`);

  // Notify both users via WebSocket
  const io = getIO();
  const initiatorSocketId = getUserSocket(updated.initiatorId);
  const receiverSocketId = getUserSocket(updated.receiverId);

  if (io) {
    if (initiatorSocketId) {
      io.to(initiatorSocketId).emit('friend:requestAccepted', updated);
      // Send the online status of the receiver to the initiator
      io.to(initiatorSocketId).emit('friend:statusChanged', {
        userId: updated.receiverId,
        online: !!receiverSocketId
      });
    }
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('friend:requestAccepted', updated);
      // Send the online status of the initiator to the receiver
      io.to(receiverSocketId).emit('friend:statusChanged', {
        userId: updated.initiatorId,
        online: !!initiatorSocketId
      });
    }
  }

  res.json(updated);
});

// Reject/Delete friend request or friendship
friendsRouter.delete('/:friendshipId', async (req, res) => {
  const user = req.user as User;
  const { friendshipId } = req.params;

  const friendship = await prisma.friendship.findUnique({
    where: { id: friendshipId }
  });

  if (!friendship) {
    return res.status(404).json({ error: 'Friendship not found' });
  }

  if (friendship.initiatorId !== user.id && friendship.receiverId !== user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  await prisma.friendship.delete({
    where: { id: friendshipId }
  });

  // Notify the other user via WebSocket
  const io = getIO();
  const otherUserId = friendship.initiatorId === user.id ? friendship.receiverId : friendship.initiatorId;
  const otherUserSocketId = getUserSocket(otherUserId);

  if (io && otherUserSocketId) {
    // If friendship was pending, use requestRejected, otherwise use removed
    if (friendship.status === 'pending') {
      io.to(otherUserSocketId).emit('friend:requestRejected', { friendshipId });
    } else {
      io.to(otherUserSocketId).emit('friend:removed', { friendshipId });
    }
  }

  res.json({ message: 'Friendship deleted' });
});
