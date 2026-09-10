import { test, expect } from '@playwright/test';
import type { Socket } from 'socket.io-client';

import { loginDev, connectSocket, createRoom, waitForEvent, clearFriendships, seatGuestByInvitation } from './helpers';
import { crc32 } from '../frontend/src/lib/roms/checksum';
import { ChunkAssembler, toChunks, type ChunkMessage } from '../frontend/src/lib/roms/transfer';

/**
 * Handing a ROM from host to guest, against the running stack.
 *
 * core/test/rom-transfer.test.ts covers the chunking and the checks either
 * side, and backend/test/rom-relay.test.ts covers the routing rules against
 * fakes. What only a real deployment answers is whether the relay in between
 * behaves: that it forwards bytes unaltered, that it carries them in whichever
 * direction they are needed, and that a room id alone does not authorise
 * pushing megabytes at somebody. The last matters because the transfer is the
 * one path in the app where one player can make another's browser allocate.
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

	test('bytes nobody asked for never arrive', async () => {
		// Otherwise the room id - which friends and invitations hand out - would
		// be enough to stream arbitrary volume at the other player. Being in the
		// room is not consent to receive four megabytes; having asked is, and
		// that is the whole of the rule now that either side may be the sender.
		const room = await roomWithBoth('ROM Transfer Authz');
		const chunk = toChunks(rom(13, 4096))[0];

		const leaked = waitForEvent<unknown>(host, 'rom:chunk', 1200);
		guest.emit('rom:chunk', { ...chunk, roomId: room.id, to: 'dev-user-1' });

		expect(await leaked).toBeNull();

		host.emit('room:leave', { roomId: room.id });
		guest.emit('room:leave', { roomId: room.id });
	});

	test('a host without the cartridge is served by its guest', async () => {
		/*
		 * The direction the relay refused until 2026-09-09. A library entry is
		 * on the server and the bytes are on one device, so a host playing from
		 * a second machine is the one missing the file - and its requests were
		 * dropped here while the guest sat holding the dump.
		 */
		const room = await roomWithBoth('ROM Transfer Upstream');
		const original = rom(19, 96 * 1024);

		const asked = waitForEvent<{ roomId: string; from: string }>(guest, 'rom:request', 5000);
		host.emit('rom:request', { roomId: room.id });
		const request = await asked;

		expect(request?.roomId).toBe(room.id);

		const assembler = new ChunkAssembler();
		const complete = new Promise<Uint8Array>((resolve, reject) => {
			host.on('rom:chunk', (message: ChunkMessage) => {
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
			guest.emit('rom:chunk', { ...chunk, roomId: room.id, to: request!.from });
		}

		const received = await complete;
		expect(crc32(received)).toBe(crc32(original));

		host.off('rom:chunk');
		host.emit('room:leave', { roomId: room.id });
		guest.emit('room:leave', { roomId: room.id });
	});

	test('an oversized chunk is dropped without breaking the connection', async () => {
		const room = await roomWithBoth('ROM Transfer Size');
		const huge = new Uint8Array(200 * 1024);

		// The guest has to have asked before anything can reach it at all, so
		// the oversized chunk is refused on its size and not on its welcome.
		const asked = waitForEvent<{ roomId: string; from: string }>(host, 'rom:request', 5000);
		guest.emit('rom:request', { roomId: room.id });
		expect(await asked).not.toBeNull();

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

	test('a game offered from the library crosses to the other player', async () => {
		/*
		 * The whole point of decoupling sharing from launching: this needs no
		 * emulator, no ROM on disk and no running match, so unlike the in-game
		 * transfer it can be driven end to end. The owner asked for the
		 * decoupling on 2026-09-10; this is the protocol it added.
		 */
		const room = await roomWithBoth('ROM Share');
		const original = rom(23, 80 * 1024);
		const dump = crc32(original);

		const offered = waitForEvent<{ roomId: string; crc32: string; title: string; from: string }>(
			guest,
			'rom:offer',
			5000
		);
		host.emit('rom:offer', { roomId: room.id, crc32: dump, title: 'Umihara Kawase' });
		const offer = await offered;

		expect(offer?.crc32).toBe(dump);
		expect(offer?.title).toBe('Umihara Kawase');
		expect(offer?.from).toBeTruthy();

		// Accepting IS the request, which is what registers consent with the
		// relay before a single byte is allowed through.
		const asked = waitForEvent<{ roomId: string; from: string; crc32: string }>(
			host,
			'rom:request',
			5000
		);
		guest.emit('rom:request', { roomId: room.id, crc32: dump });
		const request = await asked;

		// Named, because a group's room usually carries no game at all - so
		// "the game this room is for" would have been nothing.
		expect(request?.crc32).toBe(dump);

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

		expect(crc32(await complete)).toBe(dump);

		guest.off('rom:chunk');
		host.emit('room:leave', { roomId: room.id });
		guest.emit('room:leave', { roomId: room.id });
	});

	test('a refused offer reaches the player who made it', async () => {
		const room = await roomWithBoth('ROM Share Declined');

		const told = waitForEvent<{ roomId: string; from: string }>(host, 'rom:offer-declined', 5000);
		guest.emit('rom:offer-declined', { roomId: room.id, to: 'dev-user-1' });

		// Without this the sender's button waits on an answer already given.
		expect((await told)?.roomId).toBe(room.id);

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
