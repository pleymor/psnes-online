import type { Page } from '@playwright/test';
import { io, Socket } from 'socket.io-client';

export const API = process.env.E2E_API_URL || 'http://localhost:3000';

/**
 * Logs in as one of the AUTH_MODE=dev users and returns its cookie header.
 *
 * User 3 signs in with no chosen pseudonym, so the onboarding gate is up and
 * the server refuses its socket. Only pass it to a test about that gate.
 */
export async function loginDev(userId: '1' | '2' | '3'): Promise<string> {
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

/**
 * Removes every link this account has, accepted or still pending.
 *
 * The pending half is not decoration. /api/friends lists accepted friendships
 * only, so a request that was sent and never answered - by an interrupted run,
 * or by someone poking the API by hand - used to survive this, and the next
 * befriendDevUsers would be told "Friendship already exists", get no id back,
 * and silently leave the two accounts unfriended. Every test that then needed
 * them to be friends failed somewhere else entirely.
 */
export async function clearFriendships(cookie: string) {
  const friends = await apiFetch(cookie, '/api/friends').then(r => r.json());
  for (const f of friends) {
    await apiFetch(cookie, `/api/friends/${f.friendshipId}`, { method: 'DELETE' });
  }

  const pending = await apiFetch(cookie, '/api/friends/requests').then(r => r.json());
  for (const request of pending) {
    await apiFetch(cookie, `/api/friends/${request.id}`, { method: 'DELETE' });
  }
}

export async function befriendDevUsers(c1: string, c2: string) {
  // Both sides: a request c1 sent and c2 never answered is listed by neither
  // c1's friends nor c1's received requests - only by c2's.
  await clearFriendships(c1);
  await clearFriendships(c2);
  // By handle, which is the only way in now: the friendId path was removed
  // because RoomPlayer.userId travels in every room payload, so keeping it
  // would have let anyone friend a player they had merely shared a game with.
  // The handle is the one dev user 2's login declares.
  const friendship = await apiFetch(c1, '/api/friends/request', {
    method: 'POST',
    body: JSON.stringify({ handle: 'DevTwo#0002' })
  }).then(r => r.json());
  await apiFetch(c2, `/api/friends/accept/${friendship.id}`, { method: 'POST' });
  return friendship;
}

/**
 * Seats a guest the way the application now actually requires: as an
 * invitee, not a trespasser. `room:join` refuses anyone who is not already a
 * player, so getting a second party into a room means friending the two dev
 * users first (an invitation can only be sent to an accepted friend, and
 * `lobby:invite` refuses otherwise) - skipped if they already are, so a spec
 * that calls this more than once does not keep tearing down and rebuilding
 * the friendship - then sending the invitation from the host and accepting
 * it from the guest. Resolves with the `room:updated` payload the guest
 * receives once it has actually taken its seat, or null if it never arrived,
 * the same contract `waitForEvent` itself has.
 */
export async function seatGuestByInvitation(
  hostCookie: string,
  guestCookie: string,
  host: Socket,
  guest: Socket,
  roomId: string,
  guestUserId: string
): Promise<unknown> {
  const friends: Array<{ friend: { id: string } }> = await apiFetch(hostCookie, '/api/friends').then(r => r.json());
  if (!friends.some(f => f.friend.id === guestUserId)) {
    await befriendDevUsers(hostCookie, guestCookie);
  }

  const invited = waitForEvent<{ id: string }>(guest, 'lobby:invitation', 5000);
  host.emit('lobby:invite', { roomId, friendId: guestUserId });
  const invitation = await invited;
  if (!invitation) return null;

  const seated = waitForEvent(guest, 'room:updated', 5000);
  guest.emit('lobby:accept', { invitationId: invitation.id });
  return seated;
}

/**
 * Makes a game resolvable on this device, so the library will show its card.
 *
 * The grid lists what this browser can find the bytes for, not what the
 * account owns: a game's identity lives on the server and its ROM never does.
 * So a test that adds a game through `POST /api/games` has given the account
 * an entry and this device nothing, and the card it then waits for is
 * correctly never drawn - the page says "None of your N games are on this
 * device" instead. This puts a stand-in in the same store a designated ROM
 * lands in, which is all `resolvableHere()` reads to decide.
 *
 * The bytes are not a ROM and are not meant to be. Nothing that goes through
 * here boots a core; anything that does has to designate a real file, and
 * `local-roms.spec.ts` is where that contract is pinned.
 *
 * The database name, version and stores are `frontend/src/lib/roms/kept-files.ts`
 * repeated by hand - a test that imported it would need IndexedDB in node.
 * They are created here too, rather than assuming the app arrived first,
 * because opening v2 without them leaves a database the app cannot use.
 */
export async function keepRomOnDevice(page: Page, checksum: string): Promise<void> {
  // IndexedDB is per-origin, and a blank tab's origin is not the app's.
  if (page.url() === 'about:blank') await page.goto('/');

  await page.evaluate(async (crc: string) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open('psnes-roms', 2);
      request.onupgradeneeded = () => {
        const opening = request.result;
        for (const store of ['handles', 'index', 'files']) {
          if (!opening.objectStoreNames.contains(store)) opening.createObjectStore(store);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').put(new Uint8Array(64), crc);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, checksum);
}

export const serverIsHealthy = async () =>
  fetch(`${API}/health`)
    .then(r => r.ok)
    .catch(() => false);
