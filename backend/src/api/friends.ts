import { Router } from 'express';
import { User } from '../types/index.js';
import { getIO, getUserSocket } from '../websocket/index.js';
import { getDb } from '../db/sqlite.js';
import {
  listAcceptedFriendshipsWithProfiles, listPendingRequestsFor,
  findFriendshipById, findFriendshipBetween, createFriendshipRequest,
  acceptFriendship, deleteFriendship
} from '../db/friendships.js';
import { findUserByHandle } from '../db/users.js';
import { parseHandle } from '../utils/pseudo.js';
import { friendLookupLimit } from '../utils/attempt-limit.js';
import { cache } from '../utils/cache.js';
import { requireAuth } from '../middleware/auth.js';
import { createLogger } from '../utils/logger.js';
import { asyncHandler } from '../middleware/async-handler.js';

const logger = createLogger('Friends');

export const friendsRouter = Router();

friendsRouter.use(requireAuth);

// Get all friends (accepted friendships)
friendsRouter.get('/', asyncHandler(async (req, res) => {
  const user = req.user as User;

  const friendships = listAcceptedFriendshipsWithProfiles(getDb(), user.id);

  // Return friendship data with friend info and dates
  const friendsData = friendships.map(f => ({
    friendshipId: f.id,
    friend: f.initiatorId === user.id ? f.receiver : f.initiator,
    friendsSince: f.updatedAt, // When the friendship was accepted
    createdAt: f.createdAt
  }));

  res.json(friendsData);
}));

// Get pending friend requests
friendsRouter.get('/requests', asyncHandler(async (req, res) => {
  const user = req.user as User;

  const requests = listPendingRequestsFor(getDb(), user.id);

  res.json(requests);
}));

/**
 * Adds a friend by handle - `Sprite#0417` - and by nothing else.
 *
 * The `friendId` path this route used to accept is gone on purpose. An
 * internal id is an unguessable UUID, so keeping it looked harmless, but it is
 * not secret: RoomPlayer.userId travels in every room payload. That path would
 * have let anyone friend a player they had merely shared a game with, without
 * ever knowing their code - which empties the rule of its meaning. Its only
 * caller was the user search, which is gone too.
 *
 * (`lobby:invite` still takes a friendId. Inviting someone who is ALREADY a
 * friend into a room is a different path and opens nothing.)
 */
friendsRouter.post('/request', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const { handle } = req.body ?? {};

  // The counterpart to a ten-thousand-wide discriminator space. Only failures
  // are counted, so this never fires for someone pasting a real handle.
  if (friendLookupLimit.blocked(user.id)) {
    return res.status(429).json({ error: 'TOO_MANY_ATTEMPTS' });
  }

  const parsed = parseHandle(handle);
  if (!parsed) {
    return res.status(400).json({ error: 'HANDLE_MALFORMED' });
  }

  const db = getDb();
  const friend = findUserByHandle(db, parsed.pseudo, parsed.discriminator);

  if (!friend) {
    // Deliberately indistinct: a pseudonym that exists with a different
    // discriminator and one that does not exist at all give the same answer.
    // Anything finer would answer "does this pseudonym exist?", which is
    // exactly the question the removed search used to answer.
    friendLookupLimit.recordFailure(user.id);
    return res.status(404).json({ error: 'HANDLE_NOT_FOUND' });
  }

  if (friend.id === user.id) {
    return res.status(400).json({ error: 'Cannot add yourself as friend' });
  }

  // Check if friendship already exists
  const existing = findFriendshipBetween(db, user.id, friend.id);

  if (existing) {
    return res.status(400).json({ error: 'Friendship already exists' });
  }

  const friendship = createFriendshipRequest(db, user.id, friend.id);

  // Notify receiver via WebSocket
  const io = getIO();
  const receiverSocketId = getUserSocket(friend.id);
  if (io && receiverSocketId) {
    io.to(receiverSocketId).emit('friend:requestReceived', friendship);
  }

  res.json(friendship);
}));

// Accept friend request
friendsRouter.post('/accept/:friendshipId', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const { friendshipId } = req.params;

  const db = getDb();
  const friendship = findFriendshipById(db, friendshipId);

  if (!friendship || friendship.receiverId !== user.id) {
    return res.status(404).json({ error: 'Friend request not found' });
  }

  const updated = acceptFriendship(db, friendshipId);

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
}));

// Reject/Delete friend request or friendship
friendsRouter.delete('/:friendshipId', asyncHandler(async (req, res) => {
  const user = req.user as User;
  const { friendshipId } = req.params;

  const db = getDb();
  const friendship = findFriendshipById(db, friendshipId);

  if (!friendship) {
    return res.status(404).json({ error: 'Friendship not found' });
  }

  if (friendship.initiatorId !== user.id && friendship.receiverId !== user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  deleteFriendship(db, friendshipId);

  // Invalidate friendship cache for both users, as the accept path does.
  // Without this, getFriendships() serves the deleted friendship for up to
  // 30s, so an unfriended user keeps receiving room updates and keeps seeing
  // the other's rooms in /api/rooms.
  cache.delete(`friendships:${friendship.initiatorId}`);
  cache.delete(`friendships:${friendship.receiverId}`);

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
}));
