import {
  createTestServer,
  closeTestServer,
  cleanupDatabase,
  cleanupRedis,
  createAuthenticatedSocketClient,
  disconnectSocketClient,
  TestServer,
} from '../helpers.js';

describe('WebSocket Simple Connection Test', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
    await cleanupDatabase();
  });

  // Test simple: une seule connexion
  it('should connect once', async () => {
    const client = await createAuthenticatedSocketClient(server, undefined, '1');
    expect(client.connected).toBe(true);
    await disconnectSocketClient(client);
  });

  // Test: 10 connexions séquentielles simples
  it('should handle 10 sequential connections', async () => {
    for (let i = 0; i < 10; i++) {
      console.log(`\n=== Attempting connection ${i + 1}/10 ===`);
      const client = await createAuthenticatedSocketClient(server, undefined, '1');
      expect(client.connected).toBe(true);
      console.log(`=== Connection ${i + 1}/10 successful ===`);

      // Attendre que la déconnexion soit complète
      await disconnectSocketClient(client);

      // Vérifier qu'il n'y a plus de sockets connectés
      const sockets = await server.io.fetchSockets();
      console.log(`=== After disconnect ${i + 1}: ${sockets.length} sockets remaining ===`);
    }
  });

  // Test: plusieurs connexions simultanées
  it('should handle 5 concurrent connections', async () => {
    const clients = await Promise.all([
      createAuthenticatedSocketClient(server, undefined, '1'),
      createAuthenticatedSocketClient(server, undefined, '1'),
      createAuthenticatedSocketClient(server, undefined, '1'),
      createAuthenticatedSocketClient(server, undefined, '1'),
      createAuthenticatedSocketClient(server, undefined, '1'),
    ]);

    clients.forEach((client, i) => {
      expect(client.connected).toBe(true);
      console.log(`Client ${i + 1} connected`);
    });

    // Déconnecter tous les clients proprement
    await Promise.all(clients.map(client => disconnectSocketClient(client)));

    const sockets = await server.io.fetchSockets();
    console.log(`After concurrent disconnect: ${sockets.length} sockets remaining`);
    expect(sockets.length).toBe(0);
  });

  // Test: nettoyer Redis entre les connexions
  it('should handle connections after Redis cleanup', async () => {
    await cleanupRedis(server);

    const client1 = await createAuthenticatedSocketClient(server, undefined, '1');
    expect(client1.connected).toBe(true);
    await disconnectSocketClient(client1);

    await cleanupRedis(server);

    const client2 = await createAuthenticatedSocketClient(server, undefined, '1');
    expect(client2.connected).toBe(true);
    await disconnectSocketClient(client2);
  });
});
