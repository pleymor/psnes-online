import request from 'supertest';
import {
  createTestServer,
  closeTestServer,
  cleanupDatabase,
  createAuthenticatedSocketClient,
  waitForSocketEvent,
  TestServer,
} from '../helpers.js';

describe('Friends E2E Tests', () => {
  let server: TestServer;
  let agent1: any;
  let agent2: any;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
    await cleanupDatabase();
  });

  beforeEach(async () => {
    await cleanupDatabase();

    // Create two authenticated agents using dev login
    agent1 = request.agent(server.app);
    await agent1.post('/auth/dev/login').send({ userId: '1' }).expect(200);

    agent2 = request.agent(server.app);
    await agent2.post('/auth/dev/login').send({ userId: '2' }).expect(200);
  });

  describe('GET /api/friends', () => {
    it('should return empty array when user has no friends', async () => {
      const response = await agent1
        .get('/api/friends')
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('should return friends list', async () => {
      // Create friendship
      const requestResponse = await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'user2@dev.local' })
        .expect(200);

      const friendshipId = requestResponse.body.id;

      // Accept friendship
      await agent2
        .post(`/api/friends/accept/${friendshipId}`)
        .expect(200);

      // Check friends list for user1
      const response = await agent1
        .get('/api/friends')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].friend.email).toBe('user2@dev.local');
    });
  });

  describe('GET /api/friends/requests', () => {
    it('should return pending friend requests', async () => {
      // Send friend request
      await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'user2@dev.local' })
        .expect(200);

      // Check pending requests for user2
      const response = await agent2
        .get('/api/friends/requests')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        status: 'pending',
        initiatorId: 'dev-user-1',
        receiverId: 'dev-user-2',
      });
    });
  });

  describe('GET /api/friends/search', () => {
    it('should search users by email', async () => {
      const response = await agent1
        .get('/api/friends/search')
        .query({ query: 'user2' })
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].email).toBe('user2@dev.local');
    });

    it('should search users by display name', async () => {
      const response = await agent1
        .get('/api/friends/search')
        .query({ query: 'Dev User 2' })
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].displayName).toBe('Dev User 2');
    });

    it('should return empty array for queries less than 2 characters', async () => {
      const response = await agent1
        .get('/api/friends/search')
        .query({ query: 'a' })
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('should exclude current user from search results', async () => {
      const response = await agent1
        .get('/api/friends/search')
        .query({ query: 'user1@dev.local' })
        .expect(200);

      expect(response.body).toEqual([]);
    });
  });

  describe('POST /api/friends/request', () => {
    it('should send friend request by email', async () => {
      const response = await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'user2@dev.local' })
        .expect(200);

      expect(response.body).toMatchObject({
        initiatorId: 'dev-user-1',
        receiverId: 'dev-user-2',
        status: 'pending',
      });
    });

    it('should return 404 for non-existent user', async () => {
      const response = await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'nonexistent@test.com' })
        .expect(404);

      expect(response.body.error).toBe('User not found');
    });

    it('should prevent adding yourself as friend', async () => {
      const response = await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'user1@dev.local' })
        .expect(400);

      expect(response.body.error).toBe('Cannot add yourself as friend');
    });

    it('should prevent duplicate friend requests', async () => {
      // Send first request
      await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'user2@dev.local' })
        .expect(200);

      // Try to send again
      const response = await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'user2@dev.local' })
        .expect(400);

      expect(response.body.error).toBe('Friendship already exists');
    });

    it('should notify receiver via WebSocket', async () => {
      const client2 = await createAuthenticatedSocketClient(server, { id: 'dev-user-2', email: 'user2@dev.local', displayName: 'Dev User 2', googleId: 'dev-google-id-2' });

      // Clear initial events
      await waitForSocketEvent(client2, 'rooms:list');

      await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'user2@dev.local' });

      const notification = await waitForSocketEvent(
        client2,
        'friend:requestReceived'
      );

      expect(notification).toMatchObject({
        initiatorId: 'dev-user-1',
        receiverId: 'dev-user-2',
        status: 'pending',
      });

      client2.disconnect();
    });
  });

  describe('POST /api/friends/accept/:friendshipId', () => {
    it('should accept friend request', async () => {
      // Send request
      const requestResponse = await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'user2@dev.local' })
        .expect(200);

      const friendshipId = requestResponse.body.id;

      // Accept request
      const response = await agent2
        .post(`/api/friends/accept/${friendshipId}`)
        .expect(200);

      expect(response.body).toMatchObject({
        id: friendshipId,
        status: 'accepted',
      });
    });

    it('should not allow non-receiver to accept request', async () => {
      // Send request
      const requestResponse = await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'user2@dev.local' })
        .expect(200);

      const friendshipId = requestResponse.body.id;

      // Try to accept with initiator's agent
      await agent1
        .post(`/api/friends/accept/${friendshipId}`)
        .expect(404);
    });
  });

  describe('DELETE /api/friends/:friendshipId', () => {
    it('should delete friendship', async () => {
      // Create and accept friendship
      const requestResponse = await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'user2@dev.local' });

      const friendshipId = requestResponse.body.id;

      await agent2
        .post(`/api/friends/accept/${friendshipId}`);

      // Delete friendship
      const response = await agent1
        .delete(`/api/friends/${friendshipId}`)
        .expect(200);

      expect(response.body.message).toBe('Friendship deleted');

      // Verify it's deleted
      const friendsList = await agent1
        .get('/api/friends')
        .expect(200);

      expect(friendsList.body).toHaveLength(0);
    });

    it('should reject pending friend request', async () => {
      // Send request
      const requestResponse = await agent1
        .post('/api/friends/request')
        .send({ friendEmail: 'user2@dev.local' });

      const friendshipId = requestResponse.body.id;

      // Reject request
      await agent2
        .delete(`/api/friends/${friendshipId}`)
        .expect(200);

      // Verify it's deleted
      const requests = await agent2
        .get('/api/friends/requests')
        .expect(200);

      expect(requests.body).toHaveLength(0);
    });
  });
});
