import { io, Socket } from 'socket.io-client';

export const API = process.env.E2E_API_URL || 'http://localhost:3000';

/** Logs in as one of the AUTH_MODE=dev users and returns its cookie header. */
export async function loginDev(userId: '1' | '2'): Promise<string> {
  const res = await fetch(`${API}/auth/dev/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId })
  });
  if (!res.ok) throw new Error(`dev login ${userId} failed: ${res.status}`);
  return res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ');
}

export function apiFetch(cookie: string, path: string, init: RequestInit = {}) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
}

/** A connected socket, carrying the `rooms:list` payload received at connect. */
export type TestSocket = Socket & { initialRoomsList: any[] };

export async function connectSocket(cookie: string): Promise<TestSocket> {
  const socket = io(API, { transports: ['websocket'], extraHeaders: { Cookie: cookie } }) as TestSocket;
  await new Promise<void>((resolve, reject) => {
    socket.on('connect_error', e => reject(new Error(`connect_error: ${e.message}`)));
    // `rooms:list` is emitted after the server has registered its handlers, so
    // waiting for it guarantees a later emit will not be dropped.
    socket.on('rooms:list', (list: any[]) => {
      socket.initialRoomsList = list;
      resolve();
    });
    setTimeout(() => reject(new Error('socket setup timeout (no rooms:list)')), 15_000);
  });
  return socket;
}

/** Waits for a single socket event, or resolves to null after `ms`. */
export function waitForEvent<T = any>(socket: Socket, event: string, ms = 3000): Promise<T | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, ms);
    const handler = (payload: T) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

export async function createRoom(socket: Socket, gameTitle: string) {
  const created = waitForEvent<any>(socket, 'room:created', 10_000);
  socket.emit('room:create', { gameId: 'e2e-no-such-game', gameTitle });
  const room = await created;
  if (!room) throw new Error('room:created never arrived');
  return room;
}

/** Removes every friendship of the dev user so visibility tests are isolated. */
export async function clearFriendships(cookie: string) {
  const friends = await apiFetch(cookie, '/api/friends').then(r => r.json());
  for (const f of friends) {
    await apiFetch(cookie, `/api/friends/${f.friendshipId}`, { method: 'DELETE' });
  }
}

export async function befriendDevUsers(c1: string, c2: string) {
  await clearFriendships(c1);
  const friendship = await apiFetch(c1, '/api/friends/request', {
    method: 'POST',
    body: JSON.stringify({ friendId: 'dev-user-2' })
  }).then(r => r.json());
  await apiFetch(c2, `/api/friends/accept/${friendship.id}`, { method: 'POST' });
  return friendship;
}

export const serverIsHealthy = async () =>
  fetch(`${API}/health`)
    .then(r => r.ok)
    .catch(() => false);
