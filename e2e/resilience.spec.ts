import { test, expect } from '@playwright/test';
import { loginDev, apiFetch, connectSocket, createRoom, serverIsHealthy } from './helpers';

/**
 * Regression tests for the crash class found while reviewing: an async handler
 * that rejects used to escalate to an unhandledRejection and terminate the
 * backend, taking every endpoint down with it.
 */
test.describe('backend resilience', () => {
  test('a throwing socket handler does not take the server down', async () => {
    const cookie = await loginDev('1');
    const socket = await connectSocket(cookie);

    // `room:create` dereferences data.autoStart; an empty payload throws inside
    // the async handler. This used to kill the process.
    socket.emit('room:create');
    socket.emit('room:create', null);
    socket.emit('game:save');
    socket.emit('sync:checksum');
    socket.emit('p2p:join');

    await new Promise(r => setTimeout(r, 2500));

    expect(await serverIsHealthy(), 'server must survive a handler throw').toBe(true);

    // ...and must still be functional, not merely listening.
    const room = await createRoom(socket, 'Post-Crash Test');
    expect(room.id).toBeTruthy();

    socket.close();
  });

  test('API endpoints stay up and authenticated after the abuse above', async () => {
    const cookie = await loginDev('1');

    for (const path of ['/api/games', '/api/rooms', '/api/friends', '/api/user/controls']) {
      const res = await apiFetch(cookie, path);
      expect(res.status, `${path} must answer 200`).toBe(200);
    }
  });

  test('unauthenticated requests are still rejected', async () => {
    for (const path of ['/api/games', '/api/rooms', '/api/friends']) {
      const res = await fetch(`${process.env.E2E_API_URL || 'http://localhost:3000'}${path}`);
      expect(res.status, `${path} must require auth`).toBe(401);
    }
  });
});
