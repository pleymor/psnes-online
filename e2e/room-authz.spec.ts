import { test, expect } from '@playwright/test';
import type { Socket } from 'socket.io-client';
import {
  loginDev, apiFetch, connectSocket, createRoom, waitForEvent,
  clearFriendships, befriendDevUsers
} from './helpers';

// Events a non-member must never be able to trigger on someone else's room.
const HOSTILE_EVENTS = (roomId: string): Array<[string, unknown]> => [
  ['game:stop', { roomId }],
  ['game:pause', { roomId }],
  ['game:start', { roomId }],
  ['game:setSpeed', { roomId, speed: 4 }],
  ['p2p:join', { roomId }],
  ['p2p:host_ready', { roomId }],
  ['webrtc:signal', { roomId, signal: { type: 'offer', sdp: 'malicious' } }],
  ['game:save', { roomId, slotNumber: 1, name: 'pwned', saveData: 'AAAA' }],
  ['sync:checksum', { roomId, frame: 1, checksum: 'deadbeef' }]
];

// Events the host would observe if any of the above took effect.
const LEAK_EVENTS = [
  'game:stopped', 'game:paused', 'game:started', 'game:loaded',
  'game:speedChanged', 'p2p:peer-joined', 'webrtc:signal', 'sync:result'
];

test.describe('room authorization', () => {
  let c1: string, c2: string, host: Socket, outsider: Socket;

  test.beforeAll(async () => {
    c1 = await loginDev('1');
    c2 = await loginDev('2');
    await clearFriendships(c1);
    host = await connectSocket(c1);
    outsider = await connectSocket(c2);
  });

  test.afterAll(() => {
    host?.close();
    outsider?.close();
  });

  test('a non-member cannot affect a room it is not in', async () => {
    const room = await createRoom(host, 'Authz Test');

    const observed: string[] = [];
    for (const ev of LEAK_EVENTS) host.on(ev, () => observed.push(ev));

    for (const [event, payload] of HOSTILE_EVENTS(room.id)) outsider.emit(event, payload);
    await new Promise(r => setTimeout(r, 2500));

    expect(observed, 'outsider must not trigger any room event').toEqual([]);
    for (const ev of LEAK_EVENTS) host.removeAllListeners(ev);
  });

  test('the host can still drive its own room', async () => {
    const room = await createRoom(host, 'Host Flow Test');
    host.emit('room:selectPort', { roomId: room.id, port: 1 });

    const paused = waitForEvent(host, 'game:paused', 4000);
    host.emit('game:pause', { roomId: room.id });
    expect(await paused, 'host pause must still work').not.toBeNull();
  });

  test('a guest who joined the room is allowed to act', async () => {
    const room = await createRoom(host, 'Guest Flow Test');

    const joined = waitForEvent(outsider, 'room:updated', 4000);
    outsider.emit('room:join', { roomId: room.id });
    expect(await joined, 'guest must be able to join').not.toBeNull();

    // Guests legitimately pause/resume/quit, so membership (not host-only) is
    // the correct gate.
    const paused = waitForEvent(host, 'game:paused', 4000);
    outsider.emit('game:pause', { roomId: room.id });
    expect(await paused, 'a member guest must be able to pause').not.toBeNull();

    outsider.emit('room:leave', { roomId: room.id });
  });

  test('GET /api/rooms hides rooms of users who are not friends', async () => {
    await clearFriendships(c1);
    const room = await createRoom(host, 'Scoping Test');

    const mine = await apiFetch(c1, '/api/rooms').then(r => r.json());
    const theirs = await apiFetch(c2, '/api/rooms').then(r => r.json());

    expect(mine.map((r: any) => r.id)).toContain(room.id);
    expect(theirs.map((r: any) => r.id)).not.toContain(room.id);
  });

  test('GET /api/rooms shows a friend’s room, without leaking keyConfig', async () => {
    await befriendDevUsers(c1, c2);
    const room = await createRoom(host, 'Friend Visible Test');

    const theirs = await apiFetch(c2, '/api/rooms').then(r => r.json());
    const seen = theirs.find((r: any) => r.id === room.id);

    expect(seen, 'a friend must see the room (the sidebar depends on it)').toBeTruthy();
    expect(seen.createdBy).toBe('dev-user-1');
    expect(seen.players[0]).not.toHaveProperty('keyConfig');
    expect(JSON.stringify(theirs)).not.toContain('keyConfig');
  });

  test('rooms:list on connect is scoped and carries no keyConfig', async () => {
    await clearFriendships(c1);
    const room = await createRoom(host, 'Socket List Test');

    // A freshly connected non-friend must not be handed the room over the
    // socket either, otherwise the REST scoping is trivially bypassed.
    const fresh = await connectSocket(c2);
    const list = fresh.initialRoomsList;
    fresh.close();

    expect(list, 'rooms:list must still be emitted at connect').toBeDefined();
    expect(list.map((r: any) => r.id)).not.toContain(room.id);
    expect(JSON.stringify(list)).not.toContain('keyConfig');
  });
});
