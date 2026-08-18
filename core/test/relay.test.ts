/**
 * Tests for the server relay, running the real backend handler.
 *
 * These bring up an actual socket.io server and real clients, so they cover
 * the parts the virtual-clock suite deliberately stubs out: slot assignment,
 * membership enforcement, and whether bytes survive the round trip through
 * socket.io intact. A full netplay session then runs over that link.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';

import { Server as IOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { registerZnetHandlers } from '../../backend/src/websocket/znet-handlers.js';
import { NetplaySession } from '../../frontend/src/lib/znet/session.js';
import { SocketTransport } from '../../frontend/src/lib/znet/socket-transport.js';
import { FakeCore } from './fake-core.js';
import { InputTape } from './helpers.js';

const ROOM_ID = 'room-1';
const HOST_ID = 'user-host';
const GUEST_ID = 'user-guest';
const OUTSIDER_ID = 'user-outsider';

interface Rig {
	http: HttpServer;
	io: IOServer;
	url: string;
	/** Mutable so a test can change room membership mid-flight. */
	rooms: Map<string, unknown>;
	close(): Promise<void>;
}

function makeRoom(playerIds: string[]) {
	return {
		id: ROOM_ID,
		gameId: 'game-1',
		gameTitle: 'Test',
		hostId: HOST_ID,
		createdBy: HOST_ID,
		status: 'waiting',
		emulationMode: 'lockstep',
		createdAt: new Date(),
		players: playerIds.map((userId) => ({
			userId,
			displayName: userId,
			port: null,
			isReady: false,
			emulationReady: false,
			keyConfig: {}
		}))
	};
}

async function startRig(): Promise<Rig> {
	const http = createServer();
	const io = new IOServer(http, { cors: { origin: '*' } });
	const rooms = new Map<string, unknown>([[ROOM_ID, makeRoom([HOST_ID, GUEST_ID])]]);

	io.on('connection', (socket) => {
		// The real app resolves the user from the session; here the client
		// states who it is, which is fine because the handler's own membership
		// check is what these tests are actually exercising.
		const userId = String(socket.handshake.auth?.userId ?? '');
		const user = { id: userId, displayName: userId } as never;
		registerZnetHandlers(socket, user, io, rooms as never);
	});

	http.listen(0);
	await once(http, 'listening');
	const port = (http.address() as AddressInfo).port;

	return {
		http,
		io,
		rooms,
		url: `http://localhost:${port}`,
		async close() {
			io.close();
			http.close();
			await once(http, 'close').catch(() => {});
		}
	};
}

async function connect(rig: Rig, userId: string): Promise<ClientSocket> {
	const socket = ioClient(rig.url, { auth: { userId }, transports: ['websocket'] });
	await once(socket, 'connect');
	return socket;
}

function nextEvent<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 3000): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			socket.off(event, handler);
			reject(new Error(`timed out waiting for ${event}`));
		}, timeoutMs);
		const handler = (payload: T) => {
			clearTimeout(timer);
			socket.off(event, handler);
			resolve(payload);
		};
		socket.on(event, handler);
	});
}

test('the relay assigns the host to player 1 and the guest to player 2', async () => {
	const rig = await startRig();
	const host = await connect(rig, HOST_ID);
	const guest = await connect(rig, GUEST_ID);

	host.emit('znet:join', { roomId: ROOM_ID });
	const hostJoin = await nextEvent<{ playerIndex: number; isHost: boolean }>(host, 'znet:joined');

	guest.emit('znet:join', { roomId: ROOM_ID });
	const guestJoin = await nextEvent<{ playerIndex: number; isHost: boolean }>(guest, 'znet:joined');

	// The room host must be player 1: its pads have to land on controller port
	// 1 on both machines, or the two emulators disagree about who is who.
	assert.equal(hostJoin.playerIndex, 0);
	assert.equal(hostJoin.isHost, true);
	assert.equal(guestJoin.playerIndex, 1);
	assert.equal(guestJoin.isHost, false);

	host.close();
	guest.close();
	await rig.close();
});

test('packets are relayed byte for byte', async () => {
	const rig = await startRig();
	const host = await connect(rig, HOST_ID);
	const guest = await connect(rig, GUEST_ID);

	host.emit('znet:join', { roomId: ROOM_ID });
	await nextEvent(host, 'znet:joined');
	guest.emit('znet:join', { roomId: ROOM_ID });
	await nextEvent(guest, 'znet:joined');

	const sent = new Uint8Array([3, 1, 0, 5, 0x11, 0x22, 0x33, 0x44, 0xff, 0x0f]);
	const received = nextEvent<{ payload: ArrayBuffer }>(guest, 'znet:packet');
	host.emit('znet:packet', { roomId: ROOM_ID, payload: sent.buffer });

	const got = new Uint8Array((await received).payload);
	assert.deepEqual([...got], [...sent], 'the relay must not alter the payload');

	host.close();
	guest.close();
	await rig.close();
});

test('a non-member cannot join or inject packets', async () => {
	const rig = await startRig();
	const host = await connect(rig, HOST_ID);
	const outsider = await connect(rig, OUTSIDER_ID);

	host.emit('znet:join', { roomId: ROOM_ID });
	await nextEvent(host, 'znet:joined');

	let leaked = false;
	host.on('znet:packet', () => {
		leaked = true;
	});

	outsider.emit('znet:join', { roomId: ROOM_ID });
	outsider.emit('znet:packet', { roomId: ROOM_ID, payload: new Uint8Array([9, 9, 9]).buffer });

	await assert.rejects(nextEvent(outsider, 'znet:joined', 500), /timed out/);
	await new Promise((r) => setTimeout(r, 300));

	// An injected pad packet would corrupt both players' input tapes and read
	// as a desync, so this has to be shut out at the door.
	assert.equal(leaked, false, 'a non-member must not be able to inject netplay packets');

	host.close();
	outsider.close();
	await rig.close();
});

test('oversized packets are dropped rather than relayed', async () => {
	const rig = await startRig();
	const host = await connect(rig, HOST_ID);
	const guest = await connect(rig, GUEST_ID);

	host.emit('znet:join', { roomId: ROOM_ID });
	await nextEvent(host, 'znet:joined');
	guest.emit('znet:join', { roomId: ROOM_ID });
	await nextEvent(guest, 'znet:joined');

	host.emit('znet:packet', { roomId: ROOM_ID, payload: new Uint8Array(200_000).buffer });
	await assert.rejects(nextEvent(guest, 'znet:packet', 600), /timed out/);

	// A normal packet still goes through, so the guard is a size check and not
	// a stuck connection.
	const ok = nextEvent<{ payload: ArrayBuffer }>(guest, 'znet:packet');
	host.emit('znet:packet', { roomId: ROOM_ID, payload: new Uint8Array([1, 2, 3]).buffer });
	assert.equal((await ok).payload.byteLength, 3);

	host.close();
	guest.close();
	await rig.close();
});

test('a full netplay session runs over the real relay', async () => {
	const rig = await startRig();
	const hostSocket = await connect(rig, HOST_ID);
	const guestSocket = await connect(rig, GUEST_ID);

	hostSocket.emit('znet:join', { roomId: ROOM_ID });
	await nextEvent(hostSocket, 'znet:joined');
	guestSocket.emit('znet:join', { roomId: ROOM_ID });
	await nextEvent(guestSocket, 'znet:joined');

	const frames = 4000;
	const hostTape = new InputTape(0xaaa).generate(frames);
	const guestTape = new InputTape(0xbbb).generate(frames);
	const inputDelay = 4;

	const hostCore = new FakeCore();
	const guestCore = new FakeCore();
	const hostCrcs = new Map<number, number>();
	const guestCrcs = new Map<number, number>();

	const host = new NetplaySession({
		core: hostCore,
		transport: new SocketTransport(hostSocket as never, ROOM_ID),
		playerIndex: 0,
		isHost: true,
		romCrc: 0xc0ffee,
		inputDelay,
		crcInterval: 30,
		readLocalInput: () => hostTape[host.currentFrame + inputDelay] ?? 0,
		onFrame: (f) => hostCrcs.set(f - 1, hostCore.wramCrc())
	});
	const guest = new NetplaySession({
		core: guestCore,
		transport: new SocketTransport(guestSocket as never, ROOM_ID),
		playerIndex: 1,
		isHost: false,
		romCrc: 0xc0ffee,
		inputDelay,
		crcInterval: 30,
		readLocalInput: () => guestTape[guest.currentFrame + inputDelay] ?? 0,
		onFrame: (f) => guestCrcs.set(f - 1, guestCore.wramCrc())
	});

	host.start();
	guest.start();

	// Real sockets mean real time. Rather than pacing to 60Hz and waiting a
	// minute, drive both sessions as fast as the loopback link allows for a
	// few seconds - the lockstep rules are the same either way.
	const deadline = Date.now() + 6000;
	while (Date.now() < deadline) {
		host.pump();
		guest.pump();
		for (let i = 0; i < 4; i++) {
			host.tick();
			guest.tick();
		}
		await new Promise((r) => setImmediate(r));
	}

	const shared = [...hostCrcs.keys()].filter((f) => guestCrcs.has(f)).sort((a, b) => a - b);
	assert.ok(shared.length > 200, `session barely progressed: ${shared.length} shared frames`);
	for (const frame of shared) {
		assert.equal(hostCrcs.get(frame), guestCrcs.get(frame), `divergence at frame ${frame}`);
	}
	assert.equal(host.getStats().desyncs, 0, 'a healthy relay must not produce desyncs');

	host.close();
	guest.close();
	hostSocket.close();
	guestSocket.close();
	await rig.close();
});

test('joining a room the server no longer has answers with an error', async () => {
	const rig = await startRig();
	try {
		// What a restart looks like from the relay's point of view: the room is
		// simply not there any more.
		rig.rooms.delete(ROOM_ID);

		const client = ioClient(rig.url, {
			transports: ['websocket'],
			auth: { userId: HOST_ID }
		});
		await once(client, 'connect');

		const failed = nextEvent<{ code?: string }>(client, 'znet:error');
		client.emit('znet:join', { roomId: ROOM_ID });
		const payload = await failed;

		assert.equal(payload.code, 'room-gone');
		client.close();
	} finally {
		await rig.close();
	}
});

test('a non-member still gets silence, not confirmation that a room exists', async () => {
	// Room ids are handed out by GET /api/rooms and by friend notifications,
	// so an error here would turn the new message into a way to probe for
	// them. The room exists; the caller is simply not in it.
	const rig = await startRig();
	try {
		const client = ioClient(rig.url, {
			transports: ['websocket'],
			auth: { userId: 'stranger' }
		});
		await once(client, 'connect');

		let heard: unknown = null;
		client.on('znet:error', (p: unknown) => (heard = p));
		client.on('znet:joined', (p: unknown) => (heard = p));
		client.emit('znet:join', { roomId: ROOM_ID });

		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(heard, null, 'a non-member must learn nothing at all');
		client.close();
	} finally {
		await rig.close();
	}
});
