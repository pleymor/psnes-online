/**
 * Shared plumbing for the netplay test suite.
 *
 * Everything here runs in plain node - no browser, no dev server, no docker.
 * A desync is a rare, timing-dependent bug; catching it needs thousands of
 * frames per run, and that is only affordable if a run is a normal unit test.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PsnesCore, type PsnesCoreFactory } from '../../frontend/src/lib/znet/core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORE_DIR = path.resolve(here, '..');
export const REPO_DIR = path.resolve(CORE_DIR, '..');

const GLUE = path.join(CORE_DIR, 'dist', 'psnes_core.mjs');
const WASM = path.join(CORE_DIR, 'dist', 'psnes_core.wasm');

export function coreIsBuilt(): boolean {
	return existsSync(GLUE) && existsSync(WASM);
}

let factory: PsnesCoreFactory | null = null;

async function getFactory(): Promise<PsnesCoreFactory> {
	if (factory) return factory;
	const mod = await import(GLUE);
	factory = (mod.default ?? mod) as PsnesCoreFactory;
	return factory;
}

/**
 * Each core is a completely separate wasm instance with its own linear memory,
 * which is the point: "two players" in these tests really is two machines that
 * share nothing but the bytes we hand them.
 */
export async function makeCore(): Promise<PsnesCore> {
	const create = await getFactory();
	const wasmBinary = readFileSync(WASM);
	return PsnesCore.create(create, {
		wasmBinary,
		locateFile: (file: string) => path.join(CORE_DIR, 'dist', file)
	});
}

/* ------------------------------------------------------------------- ROMs */

/**
 * Reads the first entry out of a zip without pulling in a dependency.
 * Handles the two compression methods anything in the wild actually uses.
 */
function unzipFirstEntry(buffer: Buffer): Buffer {
	if (buffer.readUInt32LE(0) !== 0x04034b50) {
		throw new Error('not a zip file');
	}
	const method = buffer.readUInt16LE(8);
	const compressedSize = buffer.readUInt32LE(18);
	const nameLength = buffer.readUInt16LE(26);
	const extraLength = buffer.readUInt16LE(28);
	const start = 30 + nameLength + extraLength;

	if (compressedSize === 0) {
		// Streamed entry: sizes live in a trailing data descriptor. Not worth
		// supporting - re-zip the ROM or point PSNES_TEST_ROM at the raw file.
		throw new Error('zip uses a streaming data descriptor; unsupported');
	}

	const body = buffer.subarray(start, start + compressedSize);
	if (method === 0) return body;
	if (method === 8) return inflateRawSync(body);
	throw new Error(`unsupported zip compression method ${method}`);
}

function stripCopierHeader(rom: Buffer): Buffer {
	// 512-byte copier headers ("SMC headers") are an artefact of 90s dumping
	// hardware. snes9x detects them itself, but stripping here keeps the CRC we
	// use for the ROM handshake stable across headered/unheadered dumps.
	return rom.length % 1024 === 512 ? rom.subarray(512) : rom;
}

export interface TestRom {
	name: string;
	data: Uint8Array;
}

/**
 * Finds a ROM to test with.
 *
 * ROMs cannot be committed, so the suite uses whatever the developer already
 * has: PSNES_TEST_ROM if set, otherwise anything sitting in the app's own
 * uploads directory. Tests skip cleanly when nothing is available.
 */
export function findTestRom(): TestRom | null {
	const explicit = process.env.PSNES_TEST_ROM;
	const candidates: string[] = [];

	if (explicit) {
		candidates.push(path.resolve(explicit));
	} else {
		for (const dir of [path.join(REPO_DIR, 'backend', 'roms'), path.join(CORE_DIR, 'test', 'roms')]) {
			if (!existsSync(dir)) continue;
			for (const entry of readdirSync(dir).sort()) {
				if (/\.(sfc|smc|zip)$/i.test(entry)) candidates.push(path.join(dir, entry));
			}
		}
	}

	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			const raw = readFileSync(candidate);
			const rom = candidate.toLowerCase().endsWith('.zip') ? unzipFirstEntry(raw) : raw;
			return { name: path.basename(candidate), data: new Uint8Array(stripCopierHeader(rom)) };
		} catch {
			// Try the next candidate rather than failing the whole suite on one
			// unreadable file.
		}
	}
	return null;
}

let crcTable: Uint32Array | null = null;

/** Same polynomial as the core's CRC32, so ROM checksums agree across the wire. */
export function crc32(data: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[i] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------- input tapes */

/**
 * A reproducible sequence of pad states.
 *
 * Random-looking input is what shakes out desyncs, but it has to be the *same*
 * random input on both peers and on every run, or a failure cannot be
 * investigated. Hence a seeded generator rather than Math.random.
 */
export class InputTape {
	private state: number;

	constructor(seed = 12345) {
		this.state = seed >>> 0 || 1;
	}

	private next(): number {
		let x = this.state;
		x ^= x << 13;
		x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5;
		x >>>= 0;
		this.state = x;
		return x;
	}

	/**
	 * Buttons are held for several frames at a time. Single-frame noise mostly
	 * gets swallowed by games' own input debouncing and exercises far less of
	 * the machine than a held direction does.
	 */
	generate(frames: number): number[] {
		const out: number[] = new Array(frames);
		let current = 0;
		let remaining = 0;
		for (let i = 0; i < frames; i++) {
			if (remaining === 0) {
				current = this.next() & 0x0fff;
				// Never hold Left+Right or Up+Down: real pads cannot, and some
				// games take genuinely undefined paths when they see it.
				if ((current & 0xc0) === 0xc0) current &= ~0x40;
				if ((current & 0x30) === 0x30) current &= ~0x20;
				remaining = 2 + (this.next() % 10);
			}
			out[i] = current;
			remaining--;
		}
		return out;
	}
}
