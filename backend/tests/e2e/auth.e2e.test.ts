import request from 'supertest';
import {
  createTestServer,
  closeTestServer,
  cleanupDatabase,
  TestServer,
} from '../helpers.js';

describe('Authentication E2E Tests', () => {
  let server: TestServer;

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

  describe('GET /auth/mode', () => {
    it('should return the current auth mode', async () => {
      const response = await request(server.app)
        .get('/auth/mode')
        .expect(200);

      expect(response.body).toHaveProperty('mode');
      expect(['dev', 'google']).toContain(response.body.mode);
    });
  });

  describe('GET /auth/me', () => {
    it('should return 401 when not authenticated', async () => {
      const response = await request(server.app)
        .get('/auth/me')
        .expect(401);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('Not authenticated');
    });

    it('should return user data when authenticated', async () => {
      // Login as dev user
      const agent = request.agent(server.app);

      const loginResponse = await agent
        .post('/auth/dev/login')
        .send({ userId: '1' })
        .expect(200);

      // Make authenticated request with same agent
      const response = await agent
        .get('/auth/me')
        .expect(200);

      expect(response.body).toMatchObject({
        id: 'dev-user-1',
        email: 'user1@dev.local',
        displayName: 'Dev User 1',
      });
    });
  });

  describe('POST /auth/logout', () => {
    it('should logout successfully when authenticated', async () => {
      // Login as dev user
      const agent = request.agent(server.app);

      await agent
        .post('/auth/dev/login')
        .send({ userId: '1' })
        .expect(200);

      // Logout
      const response = await agent
        .post('/auth/logout')
        .expect(200);

      expect(response.body).toHaveProperty('message');
      expect(response.body.message).toBe('Logged out successfully');
    });
  });

  describe('POST /auth/dev/login (dev mode)', () => {
    it('should login as dev user 1', async () => {
      const response = await request(server.app)
        .post('/auth/dev/login')
        .send({ userId: '1' })
        .expect(200);

      expect(response.body).toMatchObject({
        id: 'dev-user-1',
        email: 'user1@dev.local',
        displayName: 'Dev User 1',
      });
    });

    it('should login as dev user 2', async () => {
      const response = await request(server.app)
        .post('/auth/dev/login')
        .send({ userId: '2' })
        .expect(200);

      expect(response.body).toMatchObject({
        id: 'dev-user-2',
        email: 'user2@dev.local',
        displayName: 'Dev User 2',
      });
    });

    it('should reject invalid user IDs', async () => {
      const response = await request(server.app)
        .post('/auth/dev/login')
        .send({ userId: '3' })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('Invalid user ID');
    });

    it('should reject missing user ID', async () => {
      const response = await request(server.app)
        .post('/auth/dev/login')
        .send({})
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });
  });
});
