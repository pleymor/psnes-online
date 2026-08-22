import { test, expect } from '@playwright/test';
import type { Socket } from 'socket.io-client';
import {
  loginDev, connectSocket, createRoom, waitForEvent, clearFriendships, seatGuestByInvitation
} from './helpers';

/**
 * Lockstep netplay relay, against the running stack.
 *
 * core/test/relay.test.ts already covers the handler in isolation. What only a
 * real deployment can answer is whether the relay behaves the same once it is
 * behind the session middleware and the real room lifecycle: whether a genuine
 * guest gets slot 2, whether a stranger with a valid session is shut out, and
 * whether packets survive the real socket.io transport unaltered.
 */
test.describe('znet relay', () => {
  let hostCookie: string, guestCookie: string;
  let host: Socket, guest: Socket;

  test.beforeAll(async () => {
    hostCookie = await loginDev('1');
    guestCookie = await loginDev('2');
    await clearFriendships(hostCookie);
    host = await connectSocket(hostCookie);
    guest = await connectSocket(guestCookie);
  });

  test.afterAll(() => {
    host?.close();
    guest?.close();
  });

  /**
   * The invitation is the only door in now: seats the guest for real rather
   * than letting it let itself in, the way a raw `room:join` used to.
   */
  async function joinAsGuest(roomId: string) {
    const seated = await seatGuestByInvitation(hostCookie, guestCookie, host, guest, roomId, 'dev-user-2');
    if (!seated) throw new Error('guest was never seated');
  }

  test('the room host takes player slot 1 and a member takes slot 2', async () => {
    const room = await createRoom(host, 'Znet Slots');

    await joinAsGuest(room.id);

    const hostJoined = waitForEvent<any>(host, 'znet:joined', 5000);
    host.emit('znet:join', { roomId: room.id });
    const hostSlot = await hostJoined;

    const guestJoined = waitForEvent<any>(guest, 'znet:joined', 5000);
    guest.emit('znet:join', { roomId: room.id });
    const guestSlot = await guestJoined;

    // The room host must be player 1. Its pads have to land on controller port
    // 1 on both machines, or the two emulators disagree about who is who and
    // every frame diverges.
    expect(hostSlot).toMatchObject({ playerIndex: 0, isHost: true });
    expect(guestSlot).toMatchObject({ playerIndex: 1, isHost: false });

    host.emit('znet:leave', { roomId: room.id });
    guest.emit('znet:leave', { roomId: room.id });
    host.emit('room:leave', { roomId: room.id });
    guest.emit('room:leave', { roomId: room.id });
  });

  test('packets cross the relay byte for byte', async () => {
    const room = await createRoom(host, 'Znet Relay');
    await joinAsGuest(room.id);

    host.emit('znet:join', { roomId: room.id });
    await waitForEvent(host, 'znet:joined', 5000);
    guest.emit('znet:join', { roomId: room.id });
    await waitForEvent(guest, 'znet:joined', 5000);

    // A real pad packet: type 3, player 0, epoch 0, three frames from 1000.
    const packet = new Uint8Array([3, 0, 0, 3, 0xe8, 0x03, 0, 0, 0x01, 0x00, 0x10, 0x01, 0xff, 0x0f]);
    const received = waitForEvent<any>(guest, 'znet:packet', 5000);
    host.emit('znet:packet', { roomId: room.id, payload: packet.buffer });

    const event = await received;
    expect(event).not.toBeNull();
    expect([...new Uint8Array(event.payload)]).toEqual([...packet]);

    host.emit('znet:leave', { roomId: room.id });
    guest.emit('znet:leave', { roomId: room.id });
    host.emit('room:leave', { roomId: room.id });
    guest.emit('room:leave', { roomId: room.id });
  });

  test('a signed-in stranger cannot join or inject into a room it is not in', async () => {
    const room = await createRoom(host, 'Znet Authz');

    host.emit('znet:join', { roomId: room.id });
    await waitForEvent(host, 'znet:joined', 5000);

    // `guest` never joined this room, so it is a stranger here.
    guest.emit('znet:join', { roomId: room.id });
    expect(await waitForEvent(guest, 'znet:joined', 1200)).toBeNull();

    // An injected pad packet would corrupt both players' input tapes and
    // surface as a desync, so it has to be refused outright.
    const leak = waitForEvent<any>(host, 'znet:packet', 1200);
    guest.emit('znet:packet', { roomId: room.id, payload: new Uint8Array([3, 1, 0, 1, 0, 0, 0, 0, 0xff, 0x0f]).buffer });
    expect(await leak).toBeNull();

    host.emit('znet:leave', { roomId: room.id });
    host.emit('room:leave', { roomId: room.id });
  });

  test('an oversized packet is dropped without breaking the connection', async () => {
    const room = await createRoom(host, 'Znet Size');
    await joinAsGuest(room.id);

    host.emit('znet:join', { roomId: room.id });
    await waitForEvent(host, 'znet:joined', 5000);
    guest.emit('znet:join', { roomId: room.id });
    await waitForEvent(guest, 'znet:joined', 5000);

    host.emit('znet:packet', { roomId: room.id, payload: new Uint8Array(200_000).buffer });
    expect(await waitForEvent(guest, 'znet:packet', 1500)).toBeNull();

    const ok = waitForEvent<any>(guest, 'znet:packet', 3000);
    host.emit('znet:packet', { roomId: room.id, payload: new Uint8Array([8, 0, 0, 0, 1, 0, 0, 0]).buffer });
    expect((await ok)?.payload).toBeTruthy();

    host.emit('znet:leave', { roomId: room.id });
    guest.emit('znet:leave', { roomId: room.id });
    host.emit('room:leave', { roomId: room.id });
    guest.emit('room:leave', { roomId: room.id });
  });
});
