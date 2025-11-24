import {
  createTestServer,
  closeTestServer,

  cleanupDatabase,
  createAuthenticatedSocketClient,
  waitForSocketEvent,
  TestServer,

} from '../helpers.js';
import { Socket as ClientSocket } from 'socket.io-client';

describe('Rooms E2E Tests', () => {
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
    await cleanupDatabase();


  });

  describe('Room Creation', () => {
    it('should create a room successfully', async () => {
      const client = await createAuthenticatedSocketClient(server, undefined, '1');

      const roomData = {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      };

      client.emit('room:create', roomData);

      const room = await waitForSocketEvent(client, 'room:created');

      expect(room).toMatchObject({
        gameId: roomData.gameId,
        gameTitle: roomData.gameTitle,
        hostId: userId1,
        status: 'waiting',
      });

      expect(room.players).toHaveLength(1);
      expect(room.players[0]).toMatchObject({
        userId: userId1,
        displayName: 'Dev User 1',
        port: null,
        isReady: false,
      });

      expect(room.id).toBeDefined();
      expect(room.createdAt).toBeDefined();

      client.disconnect();
    });

    it('should create a room with autoStart', async () => {
      const client = await createAuthenticatedSocketClient(server, undefined, '1');

      const roomData = {
        gameId: 'test-game',
        gameTitle: 'Test Game',
        autoStart: true,
      };

      client.emit('room:create', roomData);

      const room = await waitForSocketEvent(client, 'room:created');

      expect(room.status).toBe('playing');
      expect(room.players[0].port).toBe(1);
      expect(room.players[0].isReady).toBe(true);

      const gameStarted = await waitForSocketEvent(client, 'game:started');
      expect(gameStarted).toBeDefined();

      client.disconnect();
    });
  });

  describe('Room Joining', () => {
    it('should allow a second user to join a room', async () => {
      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      // User 1 creates room
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      const createdRoom = await waitForSocketEvent(client1, 'room:created');

      // User 2 joins room
      client2.emit('room:join', { roomId: createdRoom.id });

      const updatedRoom = await waitForSocketEvent(client2, 'room:updated');

      expect(updatedRoom.players).toHaveLength(2);
      expect(updatedRoom.players[1]).toMatchObject({
        userId: userId2,
        displayName: 'Dev User 2',
        port: null,
        isReady: false,
      });

      client1.disconnect();
      client2.disconnect();
    });

    it('should return error when joining non-existent room', async () => {
      const client = await createAuthenticatedSocketClient(server, undefined, '1');

      client.emit('room:join', { roomId: 'non-existent-room-id' });

      const error = await waitForSocketEvent(client, 'error');
      expect(error.message).toBe('Room not found');

      client.disconnect();
    });
  });

  describe('Room Port Selection', () => {
    it('should allow players to select controller ports', async () => {
      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      // User 1 creates room
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      const createdRoom = await waitForSocketEvent(client1, 'room:created');

      // User 2 joins
      client2.emit('room:join', { roomId: createdRoom.id });
      await waitForSocketEvent(client2, 'room:updated');

      // User 1 selects port 1
      client1.emit('room:selectPort', { roomId: createdRoom.id, port: 1 });
      const roomAfterPort1 = await waitForSocketEvent(client1, 'room:updated');

      const player1 = roomAfterPort1.players.find((p: any) => p.userId === userId1);
      expect(player1.port).toBe(1);
      expect(player1.isReady).toBe(true);

      // User 2 selects port 2
      client2.emit('room:selectPort', { roomId: createdRoom.id, port: 2 });
      const roomAfterPort2 = await waitForSocketEvent(client2, 'room:updated');

      const player2 = roomAfterPort2.players.find((p: any) => p.userId === userId2);
      expect(player2.port).toBe(2);
      expect(player2.isReady).toBe(true);

      client1.disconnect();
      client2.disconnect();
    });

    it('should swap ports when selecting occupied port', async () => {
      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      // User 1 creates room
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      const createdRoom = await waitForSocketEvent(client1, 'room:created');

      // User 2 joins
      client2.emit('room:join', { roomId: createdRoom.id });
      await waitForSocketEvent(client2, 'room:updated');

      // User 1 selects port 1
      client1.emit('room:selectPort', { roomId: createdRoom.id, port: 1 });
      await waitForSocketEvent(client1, 'room:updated');

      // User 2 selects port 1 (should swap User 1 to port 2)
      client2.emit('room:selectPort', { roomId: createdRoom.id, port: 1 });
      const swappedRoom = await waitForSocketEvent(client2, 'room:updated');

      const player1 = swappedRoom.players.find((p: any) => p.userId === userId1);
      const player2 = swappedRoom.players.find((p: any) => p.userId === userId2);

      expect(player1.port).toBe(2);
      expect(player2.port).toBe(1);

      client1.disconnect();
      client2.disconnect();
    });

    it('should allow unselecting port', async () => {
      const client = await createAuthenticatedSocketClient(server, undefined, '1');

      client.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      const createdRoom = await waitForSocketEvent(client, 'room:created');

      // Select port 1
      client.emit('room:selectPort', { roomId: createdRoom.id, port: 1 });
      await waitForSocketEvent(client, 'room:updated');

      // Unselect port
      client.emit('room:unselectPort', { roomId: createdRoom.id });
      const roomAfterUnselect = await waitForSocketEvent(client, 'room:updated');

      const player = roomAfterUnselect.players[0];
      expect(player.port).toBeNull();
      expect(player.isReady).toBe(false);

      client.disconnect();
    });
  });

  describe('Room Leaving', () => {
    it('should remove player when leaving room', async () => {
      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      // User 1 creates room
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      const createdRoom = await waitForSocketEvent(client1, 'room:created');

      // User 2 joins
      client2.emit('room:join', { roomId: createdRoom.id });
      await waitForSocketEvent(client2, 'room:updated');

      // User 2 leaves
      client2.emit('room:leave', { roomId: createdRoom.id });

      const playerLeftEvent = await waitForSocketEvent(client1, 'player:left');
      expect(playerLeftEvent.userId).toBe(userId2);

      const updatedRoom = await waitForSocketEvent(client1, 'room:updated');
      expect(updatedRoom.players).toHaveLength(1);
      expect(updatedRoom.players[0].userId).toBe(userId1);

      client1.disconnect();
      client2.disconnect();
    });

    it('should destroy room when last player leaves', async () => {
      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      // User 1 creates room
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      const createdRoom = await waitForSocketEvent(client1, 'room:created');

      // User 1 leaves (last player)
      client1.emit('room:leave', { roomId: createdRoom.id });

      const roomDestroyed = await waitForSocketEvent(client2, 'room:destroyed');
      expect(roomDestroyed.roomId).toBe(createdRoom.id);

      client1.disconnect();
      client2.disconnect();
    });

    it('should transfer host when host leaves', async () => {
      const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
      const client2 = await createAuthenticatedSocketClient(server, undefined, '2');

      // User 1 creates room
      client1.emit('room:create', {
        gameId: 'test-game',
        gameTitle: 'Test Game',
      });

      const createdRoom = await waitForSocketEvent(client1, 'room:created');
      expect(createdRoom.hostId).toBe(userId1);

      // User 2 joins
      client2.emit('room:join', { roomId: createdRoom.id });
      await waitForSocketEvent(client2, 'room:updated');

      // User 1 (host) leaves
      client1.emit('room:leave', { roomId: createdRoom.id });

      await waitForSocketEvent(client2, 'host:left');
      const updatedRoom = await waitForSocketEvent(client2, 'room:updated');

      expect(updatedRoom.hostId).toBe(userId2);
      expect(updatedRoom.players).toHaveLength(1);

      client1.disconnect();
      client2.disconnect();
    });
  });
});
