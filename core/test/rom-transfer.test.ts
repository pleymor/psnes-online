/**
 * Tests for handing a ROM from the host to a guest who lacks one.
 *
 * The failure mode worth guarding is not "the transfer breaks" - that is loud
 * and obvious. It is a transfer that half-works: a truncated buffer, a chunk
 * dropped in the middle, or bytes from the wrong cartridge, all of which hand
 * the emulator something it will happily run for a few seconds before the two
 * machines diverge with nothing in the logs to say why. So everything that
 * arrives is checked against the checksum the room advertises, and a transfer
 * that cannot complete has to fail rather than resolve to something plausible.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { crc32 } from '../../frontend/src/lib/roms/checksum.js';
import {
	CHUNK_BYTES,
	ChunkAssembler,
	matchesRoom,
	receiveRom,
	sendRom,
	toChunks,
	type RomChunk,
	type TransferSocket
} from '../../frontend/src/lib/roms/transfer.js';

function rom(seed: number, size = CHUNK_BYTES * 3 + 517): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = (i * seed + (i >> 8)) & 0xff;
	return bytes;
}

/**
 * A stand-in for the pair of sockets either side of the relay.
 *
 * The server forwards `rom:chunk` untouched, so a plain fan-out models it
 * faithfully enough to test both ends against each other.
 */
function relay() {
	const handlers = new Map<string, Set<(payload: never) => void>>();
	const sent: Array<{ event: string; payload: never }> = [];

	const socket: TransferSocket & { deliver(event: string, payload: unknown): void } = {
		emit(event, payload) {
			sent.push({ event, payload: payload as never });
		},
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)!.add(handler);
		},
		off(event, handler) {
			handlers.get(event)?.delete(handler);
		},
		deliver(event, payload) {
			for (const handler of [...(handlers.get(event) ?? [])]) handler(payload as never);
		}
	};

	return { socket, sent };
}

test('a ROM survives being cut into chunks and put back together', () => {
	const original = rom(19);
	const assembler = new ChunkAssembler();

	let out: Uint8Array | null = null;
	for (const chunk of toChunks(original)) out = assembler.accept(chunk);

	assert.ok(out, 'the last chunk must complete the ROM');
	assert.deepEqual([...out!], [...original]);
	assert.equal(crc32(out!), crc32(original), 'and it is byte-identical, not merely the right length');
});

test('chunks arriving out of order still reassemble', () => {
	const original = rom(23);
	const chunks = toChunks(original).reverse();
	const assembler = new ChunkAssembler();

	let out: Uint8Array | null = null;
	for (const chunk of chunks) out = assembler.accept(chunk);

	assert.deepEqual([...out!], [...original]);
});

test('a missing chunk never completes', () => {
	// The dangerous case: a buffer of the right size, mostly correct, that
	// would start and then desync. It must not be handed back at all.
	const original = rom(29);
	const chunks = toChunks(original);
	const assembler = new ChunkAssembler();

	let out: Uint8Array | null = null;
	for (const chunk of chunks.slice(1)) out = assembler.accept(chunk);

	assert.equal(out, null);
	assert.equal(assembler.received, chunks.length - 1);
	assert.ok(assembler.progress < 1);
});

test('a duplicated chunk does not fake progress', () => {
	const original = rom(31);
	const chunks = toChunks(original);
	const assembler = new ChunkAssembler();

	assembler.accept(chunks[0]);
	assembler.accept(chunks[0]);

	assert.equal(assembler.received, 1, 'the same chunk twice is still one chunk');
});

test('a single-chunk ROM is handled', () => {
	const small = rom(37, 1024);
	const chunks = toChunks(small);

	assert.equal(chunks.length, 1);
	assert.deepEqual([...new ChunkAssembler().accept(chunks[0])!], [...small]);
});

test('the guest accepts a transfer that matches the room', async () => {
	const original = rom(41);
	const checksum = crc32(original);
	const { socket, sent } = relay();

	const receiving = receiveRom({ socket, roomId: 'room-1', expectedCrc32: checksum });

	assert.equal(sent[0].event, 'rom:request', 'the guest asks before it waits');

	await sendRom({
		socket: { emit: (_e, p) => socket.deliver('rom:chunk', { ...(p as object), roomId: 'room-1' }), on() {}, off() {} },
		roomId: 'room-1',
		to: 'guest',
		rom: original
	});

	assert.deepEqual([...(await receiving)], [...original]);
});

test('the guest refuses a transfer of a different dump', async () => {
	// Same game, another dump: the one case where every byte looks reasonable
	// and only the checksum tells the truth.
	const { socket } = relay();
	const receiving = receiveRom({ socket, roomId: 'room-1', expectedCrc32: crc32(rom(43)) });

	await sendRom({
		socket: { emit: (_e, p) => socket.deliver('rom:chunk', { ...(p as object), roomId: 'room-1' }), on() {}, off() {} },
		roomId: 'room-1',
		to: 'guest',
		rom: rom(47)
	});

	await assert.rejects(receiving, /different dump/);
});

test('chunks for another room are ignored', async () => {
	const original = rom(53);
	const { socket } = relay();
	const receiving = receiveRom({
		socket,
		roomId: 'room-1',
		expectedCrc32: crc32(original),
		timeouts: { request: 60, stall: 60 }
	});

	for (const chunk of toChunks(original)) socket.deliver('rom:chunk', { ...chunk, roomId: 'room-2' });

	await assert.rejects(receiving, /stopped sending/, 'a stray room must not complete the transfer');
});

test('the guest keeps asking until the host is listening', async () => {
	// Both machines boot at once, so the first request routinely arrives before
	// the host has a handler for it. Asking once would turn that race into
	// twenty seconds of dead air and a prompt the player did not need.
	const original = rom(83);
	const { socket, sent } = relay();

	const receiving = receiveRom({
		socket,
		roomId: 'room-1',
		expectedCrc32: crc32(original),
		timeouts: { request: 900, stall: 900, retry: 20 }
	});

	await new Promise((r) => setTimeout(r, 70));
	assert.ok(sent.length > 1, `the question must be repeated, saw ${sent.length}`);

	for (const chunk of toChunks(original)) socket.deliver('rom:chunk', { ...chunk, roomId: 'room-1' });
	await receiving;

	const asked = sent.length;
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(sent.length, asked, 'and it stops once the host answers');
});

test('a host with no copy tells the guest instead of leaving it waiting', async () => {
	const { socket } = relay();
	const receiving = receiveRom({ socket, roomId: 'room-1', expectedCrc32: 'A1B2C3D4' });

	socket.deliver('rom:unavailable', { roomId: 'room-1', reason: 'The host does not have this ROM either' });

	await assert.rejects(receiving, /does not have this ROM/);
});

test('a transfer that goes silent gives up rather than hanging', async () => {
	const original = rom(59);
	const { socket } = relay();
	const receiving = receiveRom({
		socket,
		roomId: 'room-1',
		expectedCrc32: crc32(original),
		timeouts: { request: 500, stall: 40 }
	});

	// One chunk, then nothing: the player has to be told, not left on a
	// progress bar that will never move again.
	socket.deliver('rom:chunk', { ...toChunks(original)[0], roomId: 'room-1' });

	await assert.rejects(receiving, /stopped sending/);
});

test('a completed transfer stops listening', async () => {
	const original = rom(61);
	const { socket } = relay();
	const receiving = receiveRom({ socket, roomId: 'room-1', expectedCrc32: crc32(original) });

	for (const chunk of toChunks(original)) socket.deliver('rom:chunk', { ...chunk, roomId: 'room-1' });
	await receiving;

	// A late duplicate must not reach a settled promise or restart a timer that
	// would then reject long after the session started.
	assert.doesNotThrow(() =>
		socket.deliver('rom:chunk', { ...toChunks(original)[0], roomId: 'room-1' })
	);
});

test('the host reports progress as it sends', async () => {
	const original = rom(67);
	const seen: Array<[number, number]> = [];

	await sendRom({
		socket: { emit() {}, on() {}, off() {} },
		roomId: 'room-1',
		to: 'guest',
		rom: original,
		onProgress: (sent, total) => seen.push([sent, total])
	});

	assert.equal(seen.length, toChunks(original).length);
	assert.deepEqual(seen[seen.length - 1], [seen.length, seen.length], 'it must end at 100%');
});

test('matchesRoom sees through a copier header', () => {
	// A headered dump is the same cartridge, and a guest holding one must not
	// be told the host sent them the wrong game.
	const body = rom(71, 64 * 1024);
	const headered = new Uint8Array(512 + body.length);
	headered.set(body, 512);

	assert.equal(matchesRoom(headered, crc32(body)), true);
	assert.equal(matchesRoom(rom(73, 64 * 1024), crc32(body)), false);
});

test('the chunk size matches what the relay will forward', () => {
	// The server drops anything larger. If these ever drift apart, every
	// transfer fails silently at the relay with nothing on the client to say so.
	const chunk: RomChunk = toChunks(rom(79))[0];
	assert.ok(chunk.payload.byteLength <= 48 * 1024, 'MAX_CHUNK_BYTES in rom-transfer.ts');
});
