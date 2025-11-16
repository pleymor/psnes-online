import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { User } from '../types/index.js';

const prisma = new PrismaClient();
export const friendsRouter = Router();

// Middleware to check authentication
const requireAuth = (req: any, res: any, next: any) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
};

friendsRouter.use(requireAuth);

// Get all friends (accepted friendships)
friendsRouter.get('/', async (req, res) => {
  const user = req.user as User;

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

  const friends = friendships.map(f =>
    f.initiatorId === user.id ? f.receiver : f.initiator
  );

  res.json(friends);
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

// Send friend request
friendsRouter.post('/request', async (req, res) => {
  const user = req.user as User;
  const { friendEmail } = req.body;

  const friend = await prisma.user.findUnique({
    where: { email: friendEmail }
  });

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
      receiver: true
    }
  });

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

  res.json({ message: 'Friendship deleted' });
});
