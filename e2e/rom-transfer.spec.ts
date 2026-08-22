import { test, expect } from '@playwright/test';
import type { Socket } from 'socket.io-client';

import { loginDev, connectSocket, createRoom, waitForEvent, clearFriendships, seatGuestByInvitation } from './helpers';
import { crc32 } from '../frontend/src/lib/roms/checksum';
import { ChunkAssembler, toChunks, type ChunkMessage } from '../frontend/src/lib/roms/transfer';

/**
 * Handing a ROM from host to guest, against the running stack.
 *
 * core/test/rom-transfer.test.ts covers the chunking and the checks either
 * side. What only a real deployment answers is whether the relay in between
 * behaves: that it forwards bytes unaltered, that it will not let a guest
 * masquerade as the sender, and that a room id alone does not authorise pushing
 * megabytes at somebody. The last two matter because the transfer is the one
 * path in the app where one player can make another's browser allocate.
 */
test.describe('ROM transfer', () => {
	let hostCookie: string, guestCookie: string;
	let host: Socket, guest: Socket;

	function rom(seed: number, size = 120 * 1024): Uint8Array {
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) bytes[i] = (i * seed + (i >> 9)) & 0xff;
		return bytes;
	}

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

	async function roomWithBoth(title: string) {
		const room = await createRoom(host, title);
		// The invitation is the only door in now: seat the guest for real
		// rather than letting it let itself in.
		const seated = await seatGuestByInvitation(hostCookie, guestCookie, host, guest, room.id, 'dev-user-2');
		if (!seated) throw new Error('guest was never seated');
		return room;
	}

	test('a ROM crosses the relay byte for byte', async () => {
		const room = await roomWithBoth('ROM Transfer');
		const original = rom(11);

		// The host answers the request the way the client does.
		const asked = waitForEvent<{ roomId: string; from: string }>(host, 'rom:request', 5000);
		guest.emit('rom:request', { roomId: room.id });
		const request = await asked;

		expect(request?.roomId).toBe(room.id);
		expect(request?.from).toBeTruthy();

		const assembler = new ChunkAssembler();
		const complete = new Promise<Uint8Array>((resolve, reject) => {
			guest.on('rom:chunk', (message: ChunkMessage) => {
				const done = assembler.accept({
					seq: message.seq,
					total: message.total,
					byteLength: message.byteLength,
					payload: message.payload
				});
				if (done) resolve(done);
			});
			setTimeout(() => reject(new Error('the transfer never completed')), 15_000);
		});

		for (const chunk of toChunks(original)) {
			host.emit('rom:chunk', { ...chunk, roomId: room.id, to: request!.from });
		}

		const received = await complete;
		expect(received.length).toBe(original.length);
		expect(crc32(received)).toBe(crc32(original));

		guest.off('rom:chunk');
		host.emit('room:leave', { roomId: room.id });
		guest.emit('room:leave', { roomId: room.id });
	});

	test('a guest cannot pose as the sender', async () => {
		// Otherwise the room id - which friends and invitations hand out - would
		// be enough to stream arbitrary volume at the other player.
		const room = await roomWithBoth('ROM Transfer Authz');
		const chunk = toChunks(rom(13, 4096))[0];

		const leaked = waitForEvent<unknown>(host, 'rom:chunk', 1200);
		guest.emit('rom:chunk', { ...chunk, roomId: room.id, to: 'dev-user-1' });

		expect(await leaked).toBeNull();

		host.emit('room:leave', { roomId: room.id });
		guest.emit('room:leave', { roomId: room.id });
	});

	test('an oversized chunk is dropped without breaking the connection', async () => {
		const room = await roomWithBoth('ROM Transfer Size');
		const huge = new Uint8Array(200 * 1024);

		const delivered = waitForEvent<unknown>(guest, 'rom:chunk', 1200);
		host.emit('rom:chunk', {
			roomId: room.id,
			to: 'dev-user-2',
			seq: 0,
			total: 1,
			byteLength: huge.length,
			payload: huge.buffer
		});

		expect(await delivered).toBeNull();
		expect(host.connected, 'the sender must stay connected').toBe(true);

		// And the relay still works afterwards.
		const small = toChunks(rom(17, 2048))[0];
		const ok = waitForEvent<ChunkMessage>(guest, 'rom:chunk', 3000);
		host.emit('rom:chunk', { ...small, roomId: room.id, to: 'dev-user-2' });
		expect(await ok).not.toBeNull();

		host.emit('room:leave', { roomId: room.id });
		guest.emit('room:leave', { roomId: room.id });
	});

	test('a stranger cannot request a ROM from a room it is not in', async () => {
		const room = await createRoom(host, 'ROM Transfer Stranger');

		const asked = waitForEvent<unknown>(host, 'rom:request', 1200);
		guest.emit('rom:request', { roomId: room.id });

		expect(await asked).toBeNull();

		host.emit('room:leave', { roomId: room.id });
	});
});
