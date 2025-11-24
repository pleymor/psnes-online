import {
  createTestServer,
  closeTestServer,
  cleanupDatabase,
  cleanupRedis,
  disconnectAllSockets,
  createAuthenticatedSocketClient,
  disconnectSocketClient,
  createFriendship,
  waitForSocketEvent,
  TestServer,
} from '../helpers.js';

describe('WebSocket E2E Tests', () => {
  let server: TestServer;
  const userId1 = 'dev-user-1';
  const userId2 = 'dev-user-2';

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
    await cleanupDatabase();
  });

  beforeEach(async () => {
    await cleanupRedis(server);  // Clean Redis before database to clear sessions first
    await cleanupDatabase();
  });

  describe('Connection', () => {
    it('should connect successfully when authenticated', async () => {
      const client = await createAuthenticatedSocketClient(server, undefined, '1');

      expect(client.connected).toBe(true);

      await disconnectSocketClient(client);
    });

    it('should receive rooms list on connect', async () => {
      const client = await createAuthenticatedSocketClient(server, undefined, '1');

      const roomsList = await waitForSocketEvent(client, 'rooms:list');

      expect(Array.isArray(roomsList)).toBe(true);

      await disconnectSocketClient(client);
    });
  });

  describe('Friend Status Notifications', () => {
    it('should notify friends when user comes online', async () => {
      // Create friendship
      await createFriendship(userId1, userId2);

      // User 1 connects first
      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      await waitForSocketEvent(client1, 'rooms:list');

      // User 2 connects - User 1 should be notified
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      const statusChanged = await waitForSocketEvent(
        client1,
        'friend:statusChanged'
      );

      expect(statusChanged).toMatchObject({
        userId: userId2,
        online: true,
      });

      await disconnectSocketClient(client1);
      await disconnectSocketClient(client2);
    });

    it('should notify friends when user goes offline', async () => {
      // Create friendship
      await createFriendship(userId1, userId2);

      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      await waitForSocketEvent(client1, 'rooms:list');
      await waitForSocketEvent(client2, 'rooms:list');

      // Clear the initial online notification
      await waitForSocketEvent(client1, 'friend:statusChanged');

      // User 2 disconnects - User 1 should be notified
      await disconnectSocketClient(client2);

      const statusChanged = await waitForSocketEvent(
        client1,
        'friend:statusChanged'
      );

      expect(statusChanged).toMatchObject({
        userId: userId2,
        online: false,
      });

      await disconnectSocketClient(client1);
    });
  });

  describe('Friend Room Notifications', () => {
    it('should notify friends when creating a room', async () => {
      // Create friendship
      await createFriendship(userId1, userId2);

      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      await waitForSocketEvent(client1, 'rooms:list');
      await waitForSocketEvent(client2, 'rooms:list');

      // Clear status notifications
      await waitForSocketEvent(client1, 'friend:statusChanged');

      // User 1 creates a room
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      // User 2 should receive notification
      const roomCreated = await waitForSocketEvent(
        client2,
        'friend:roomCreated'
      );

      expect(roomCreated).toMatchObject({
        userId: userId1,
      });

      expect(roomCreated.room).toMatchObject({
        gameId: 'test-game',
        gameTitle: 'Test Game',
        hostId: userId1,
        status: 'waiting',
      });

      await disconnectSocketClient(client1);
      await disconnectSocketClient(client2);
    });

    it('should notify friends when room status changes to playing', async () => {
      // Create friendship
      await createFriendship(userId1, userId2);

      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      await waitForSocketEvent(client1, 'rooms:list');
      await waitForSocketEvent(client2, 'rooms:list');

      // Clear initial notifications
      await waitForSocketEvent(client1, 'friend:statusChanged');

      // User 1 creates a room with autoStart
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
        autoStart: true,
      });

      // User 2 should receive room created notification
      await waitForSocketEvent(client2, 'friend:roomCreated');

      // User 2 should receive room status changed notification
      const statusChanged = await waitForSocketEvent(
        client2,
        'friend:roomStatusChanged'
      );

      expect(statusChanged).toMatchObject({
        userId: userId1,
        status: 'playing',
      });

      await disconnectSocketClient(client1);
      await disconnectSocketClient(client2);
    });

    it('should notify friends when room is destroyed', async () => {
      // Create friendship
      await createFriendship(userId1, userId2);

      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      await waitForSocketEvent(client1, 'rooms:list');
      await waitForSocketEvent(client2, 'rooms:list');

      // Clear initial notifications
      await waitForSocketEvent(client1, 'friend:statusChanged');

      // User 1 creates a room
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      const roomCreatedNotification = await waitForSocketEvent(
        client2,
        'friend:roomCreated'
      );

      const roomId = roomCreatedNotification.room.id;

      // User 1 leaves the room (destroys it)
      client1.emit('room:leave', { roomId });

      // User 2 should receive room status changed notification
      const statusChanged = await waitForSocketEvent(
        client2,
        'friend:roomStatusChanged'
      );

      expect(statusChanged).toMatchObject({
        userId: userId1,
        roomId,
        status: 'destroyed',
      });

      await disconnectSocketClient(client1);
      await disconnectSocketClient(client2);
    });
  });

  describe('Room Broadcasting', () => {
    it('should broadcast room updates to all connected clients', async () => {
      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      await waitForSocketEvent(client1, 'rooms:list');
      await waitForSocketEvent(client2, 'rooms:list');

      // User 1 creates a room
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      await waitForSocketEvent(client1, 'room:created');

      // User 2 should receive room update broadcast
      const roomUpdate = await waitForSocketEvent(client2, 'room:update');

      expect(roomUpdate).toMatchObject({
        gameId: 'test-game',
        gameTitle: 'Test Game',
        hostId: userId1,
      });

      await disconnectSocketClient(client1);
      await disconnectSocketClient(client2);
    });

    it('should broadcast room destruction to all clients', async () => {
      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      await waitForSocketEvent(client1, 'rooms:list');
      await waitForSocketEvent(client2, 'rooms:list');

      // User 1 creates a room
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      const createdRoom = await waitForSocketEvent(client1, 'room:created');
      await waitForSocketEvent(client2, 'room:update');

      // User 1 leaves the room
      client1.emit('room:leave', { roomId: createdRoom.id });

      // User 2 should receive room destroyed broadcast
      const roomDestroyed = await waitForSocketEvent(client2, 'room:destroyed');

      expect(roomDestroyed.roomId).toBe(createdRoom.id);

      await disconnectSocketClient(client1);
      await disconnectSocketClient(client2);
    });
  });

  describe('Multi-user Room Interactions', () => {
    it('should handle complete multiplayer flow', async () => {
      // Create friendship
      await createFriendship(userId1, userId2);

      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      await waitForSocketEvent(client1, 'rooms:list');
      await waitForSocketEvent(client2, 'rooms:list');

      // Clear initial notifications
      await waitForSocketEvent(client1, 'friend:statusChanged');

      // 1. User 1 creates a room
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      const createdRoom = await waitForSocketEvent(client1, 'room:created');
      const roomCreatedNotification = await waitForSocketEvent(
        client2,
        'friend:roomCreated'
      );

      expect(roomCreatedNotification.room.id).toBe(createdRoom.id);

      // 2. User 2 joins the room
      client2.emit('room:join', { roomId: createdRoom.id });

      const roomUpdated1 = await waitForSocketEvent(client1, 'room:updated');
      const roomUpdated2 = await waitForSocketEvent(client2, 'room:updated');

      expect(roomUpdated1.players).toHaveLength(2);
      expect(roomUpdated2.players).toHaveLength(2);

      // 3. Both users select ports
      client1.emit('room:selectPort', { roomId: createdRoom.id, port: 1 });
      await waitForSocketEvent(client1, 'room:updated');

      client2.emit('room:selectPort', { roomId: createdRoom.id, port: 2 });
      const roomAfterPorts = await waitForSocketEvent(client2, 'room:updated');

      const player1 = roomAfterPorts.players.find(
        (p: any) => p.userId === userId1
      );
      const player2 = roomAfterPorts.players.find(
        (p: any) => p.userId === userId2
      );

      expect(player1.port).toBe(1);
      expect(player1.isReady).toBe(true);
      expect(player2.port).toBe(2);
      expect(player2.isReady).toBe(true);

      // 4. User 2 leaves
      client2.emit('room:leave', { roomId: createdRoom.id });

      const playerLeft = await waitForSocketEvent(client1, 'player:left');
      expect(playerLeft.userId).toBe(userId2);

      const roomAfterLeave = await waitForSocketEvent(client1, 'room:updated');
      expect(roomAfterLeave.players).toHaveLength(1);

      await disconnectSocketClient(client1);
      await disconnectSocketClient(client2);
    });
  });
});
