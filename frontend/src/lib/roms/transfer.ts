/**
 * Sending a room's ROM from the host to a guest who does not have it.
 *
 * The guest joins a room for a cartridge they may not own a copy of, and the
 * host has one loaded by definition. Rather than send them away to find a file,
 * the bytes come across the same socket the pads will later use. The server
 * forwards chunks and keeps none of them.
 *
 * Two things make this safe to hand straight to an emulator. The transfer is
 * only ever accepted from the room host, and what arrives is hashed and
 * compared against the checksum the room advertises - so a truncated,
 * reordered or simply wrong transfer is rejected here rather than starting a
 * session that desynchronises a few seconds in.
 *
 * Free of SvelteKit aliases so it runs under plain node in the test suite.
 */

import { crc32, normaliseRom } from './checksum.js';

/** Kept in step with MAX_CHUNK_BYTES in the server's relay. */
export const CHUNK_BYTES = 48 * 1024;

/** How long a guest waits for the host to start sending before giving up. */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * How often the request is repeated while nothing has come back.
 *
 * Both machines boot at once, so the guest can easily ask before the host is
 * listening. Asking once and waiting out the timeout would turn a race of a few
 * hundred milliseconds into twenty seconds of dead air followed by a prompt the
 * player did not need.
 */
export const REQUEST_RETRY_MS = 2_000;

/** How long a stalled transfer is allowed to sit before it is abandoned. */
export const STALL_TIMEOUT_MS = 30_000;

/** The bits of a socket this module needs, so tests can supply their own. */
export interface TransferSocket {
	emit(event: string, payload: unknown): void;
	on(event: string, handler: (payload: never) => void): void;
	off(event: string, handler: (payload: never) => void): void;
}

/** A piece of a ROM, as split and as reassembled. */
export interface RomChunk {
	seq: number;
	total: number;
	byteLength: number;
	payload: ArrayBuffer;
}

/** The same, once it has been through the relay and knows which room it is for. */
export interface ChunkMessage extends RomChunk {
	roomId: string;
}

/**
 * Splits a ROM into relay-sized pieces.
 *
 * `byteLength` travels with every chunk rather than being announced once: a
 * receiver that joins mid-stream, or misses the first message, can still size
 * its buffer instead of guessing.
 */
export function toChunks(rom: Uint8Array): RomChunk[] {
	const total = Math.max(1, Math.ceil(rom.length / CHUNK_BYTES));
	const chunks: RomChunk[] = [];

	for (let seq = 0; seq < total; seq++) {
		const slice = rom.slice(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
		chunks.push({
			seq,
			total,
			byteLength: rom.length,
			payload: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer
		});
	}
	return chunks;
}

/**
 * Reassembles chunks as they arrive, in any order.
 *
 * Out-of-order delivery is not expected over a socket, but a receiver that
 * only works in order fails obscurely if it ever happens, and indexing by
 * sequence number costs nothing.
 */
export class ChunkAssembler {
	private buffer: Uint8Array | null = null;
	private readonly seen = new Set<number>();
	private expected = 0;

	get received(): number {
		return this.seen.size;
	}

	get total(): number {
		return this.expected;
	}

	/** 0 to 1, for a progress bar that means something before the first chunk. */
	get progress(): number {
		return this.expected === 0 ? 0 : this.seen.size / this.expected;
	}

	/** Returns the full ROM once the last missing chunk lands, otherwise null. */
	accept(chunk: RomChunk): Uint8Array | null {
		if (!this.buffer) {
			this.buffer = new Uint8Array(chunk.byteLength);
			this.expected = chunk.total;
		}

		// A transfer that changes its mind about its own size is not one we can
		// finish; ignoring the stray chunk keeps the sane ones usable.
		if (chunk.total !== this.expected || chunk.byteLength !== this.buffer.length) return null;
		if (chunk.seq < 0 || chunk.seq >= this.expected) return null;

		const bytes = new Uint8Array(chunk.payload);
		const offset = chunk.seq * CHUNK_BYTES;
		if (offset + bytes.length > this.buffer.length) return null;

		this.buffer.set(bytes, offset);
		this.seen.add(chunk.seq);

		return this.seen.size === this.expected ? this.buffer : null;
	}
}

/** Whether a received ROM really is the cartridge the room is for. */
export function matchesRoom(rom: Uint8Array, expectedCrc32: string): boolean {
	return crc32(normaliseRom(rom)) === expectedCrc32;
}

export interface SendOptions {
	socket: TransferSocket;
	roomId: string;
	/** The guest that asked. */
	to: string;
	rom: Uint8Array;
	onProgress?: (sent: number, total: number) => void;
	/** Yields between chunks so a 4MB ROM does not freeze the host's frame loop. */
	pause?: () => Promise<void>;
}

/**
 * Ships a ROM to one guest, a chunk at a time.
 *
 * The host is running an emulator at 60fps while this happens, so it yields
 * between chunks. Pushing four megabytes into the socket in one go stalls the
 * frame loop, and a host that stutters stalls the guest too - lockstep runs no
 * faster than its slowest peer.
 */
export async function sendRom(options: SendOptions): Promise<void> {
	const { socket, roomId, to, rom, onProgress, pause } = options;
	const chunks = toChunks(rom);

	for (const chunk of chunks) {
		socket.emit('rom:chunk', { ...chunk, roomId, to });
		onProgress?.(chunk.seq + 1, chunks.length);
		if (pause) await pause();
	}
}

export interface ReceiveOptions {
	socket: TransferSocket;
	roomId: string;
	/** The checksum the room advertises; what arrives has to match it. */
	expectedCrc32: string;
	onProgress?: (received: number, total: number) => void;
	/** Injected in tests so a stalled transfer does not take half a minute to fail. */
	timeouts?: { request?: number; stall?: number; retry?: number };
}

/**
 * Asks the host for the ROM and waits for it.
 *
 * Rejects rather than resolving to null, because every failure here is
 * something the player needs told: the host is gone, the host has no copy
 * either, or what arrived is not this cartridge. The caller falls back to
 * asking the player for the file.
 */
export function receiveRom(options: ReceiveOptions): Promise<Uint8Array> {
	const { socket, roomId, expectedCrc32, onProgress } = options;
	const requestTimeout = options.timeouts?.request ?? REQUEST_TIMEOUT_MS;
	const stallTimeout = options.timeouts?.stall ?? STALL_TIMEOUT_MS;
	const retryEvery = options.timeouts?.retry ?? REQUEST_RETRY_MS;

	return new Promise<Uint8Array>((resolve, reject) => {
		const assembler = new ChunkAssembler();
		let timer: ReturnType<typeof setTimeout>;
		let retry: ReturnType<typeof setInterval> | null = null;

		const stopAsking = () => {
			if (retry !== null) clearInterval(retry);
			retry = null;
		};

		const finish = (fn: () => void) => {
			clearTimeout(timer);
			stopAsking();
			socket.off('rom:chunk', onChunk as never);
			socket.off('rom:unavailable', onUnavailable as never);
			fn();
		};

		// Restarted on every chunk: the deadline that matters is silence, not
		// total duration. A slow link should not fail a transfer that is
		// visibly progressing.
		const arm = (ms: number) =>
			(timer = setTimeout(
				() => finish(() => reject(new Error('The host stopped sending the ROM'))),
				ms
			));

		function onChunk(message: ChunkMessage) {
			if (message.roomId !== roomId) return;

			clearTimeout(timer);
			// The host is answering, so stop repeating the question.
			stopAsking();
			const rom = assembler.accept(message);
			onProgress?.(assembler.received, assembler.total);

			if (!rom) return arm(stallTimeout);

			finish(() => {
				if (!matchesRoom(rom, expectedCrc32)) {
					reject(new Error('The ROM the host sent is a different dump'));
				} else {
					resolve(rom);
				}
			});
		}

		function onUnavailable(message: { roomId: string; reason?: string }) {
			if (message.roomId !== roomId) return;
			finish(() => reject(new Error(message.reason || 'The host does not have this ROM either')));
		}

		socket.on('rom:chunk', onChunk as never);
		socket.on('rom:unavailable', onUnavailable as never);
		socket.emit('rom:request', { roomId });
		retry = setInterval(() => socket.emit('rom:request', { roomId }), retryEvery);
		arm(requestTimeout);
	});
}
