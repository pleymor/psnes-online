import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { inflateRawSync } from 'zlib';
import { Game } from '@prisma/client';
import { downloadDriveFile } from './google-drive.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RomSource');

/**
 * Reading a ROM, whatever it was added from.
 *
 * A game comes either from the owner's Google Drive or from a file they
 * uploaded. Everything downstream - the download endpoint, the per-room cache,
 * netplay - only wants the bytes, so the branch lives here rather than being
 * repeated (and drifting) at each call site.
 */

/** Resolved per call, not at import: a module-scope read of the environment
 *  cannot be overridden by a caller, which makes this whole file untestable. */
function romsDir(): string {
	return process.env.ROMS_DIR || './roms';
}

/** Extensions the emulator cores can actually load. */
export const ALLOWED_ROM_EXTENSIONS = ['.smc', '.sfc', '.fig', '.swc', '.mgd', '.zip'];

/** A 4MB cartridge is the largest the SNES ever shipped; 8MB covers oddities. */
export const MAX_ROM_BYTES = 8 * 1024 * 1024;

/**
 * Reads a game's ROM, expanding it if it turns out to be an archive.
 *
 * Uploads are unzipped once, on arrival. Drive-backed games are not: whatever
 * the player put in their Drive is what comes back, and that is very often a
 * .zip. The RetroArch build behind the dual and streaming modes opens those
 * itself, which is why this went unnoticed - but the lockstep core is a bare
 * libretro frontend with no archive support. It does not refuse a zip either:
 * it loads the bytes, runs at a full 60fps and renders black.
 */
export async function readRom(game: Game, ownerUserId: string): Promise<Buffer> {
	const raw = await readRawRom(game, ownerUserId);
	return looksLikeZip(raw) ? unzipFirstRom(raw) : raw;
}

function looksLikeZip(data: Buffer): boolean {
	return data.length > 4 && data.readUInt32LE(0) === 0x04034b50;
}

async function readRawRom(game: Game, ownerUserId: string): Promise<Buffer> {
	if (game.localPath) {
		const absolute = path.resolve(romsDir(), game.localPath);
		// Defence in depth: localPath is generated server-side, but a stored
		// value that escaped ROMS_DIR would turn this into an arbitrary file
		// read for anyone in the room.
		if (!absolute.startsWith(path.resolve(romsDir()) + path.sep)) {
			throw new Error('ROM path escapes the ROM directory');
		}
		return fs.readFile(absolute);
	}

	if (game.driveFileId) {
		return downloadDriveFile(ownerUserId, game.driveFileId);
	}

	throw new Error(`Game ${game.id} has neither a local file nor a Drive reference`);
}

/**
 * Stores an uploaded ROM and returns the name to put in `Game.localPath`.
 *
 * Archives are expanded here rather than at load time. The lockstep core is a
 * bare libretro frontend with no archive support, and having one mode able to
 * open a file that another cannot is a worse problem than unzipping once.
 */
export async function storeUploadedRom(
	originalName: string,
	data: Buffer
): Promise<{ localPath: string; filename: string; bytes: Buffer }> {
	const ext = path.extname(originalName).toLowerCase();
	const bytes = ext === '.zip' ? unzipFirstRom(data) : data;
	const filename = ext === '.zip' ? zipEntryName(data, originalName) : originalName;

	await fs.mkdir(romsDir(), { recursive: true });

	// A generated name, never the user's: uploaded filenames are attacker
	// controlled and this one becomes a filesystem path.
	const localPath = `${randomUUID()}${path.extname(filename).toLowerCase() || '.sfc'}`;
	await fs.writeFile(path.join(romsDir(), localPath), bytes);

	logger.info({ localPath, bytes: bytes.length }, 'Stored uploaded ROM');
	return { localPath, filename, bytes };
}

export async function deleteLocalRom(localPath: string | null): Promise<void> {
	if (!localPath) return;
	try {
		await fs.unlink(path.join(romsDir(), localPath));
	} catch (err) {
		// A missing file is not worth failing a delete over - the row is going
		// away either way.
		logger.warn({ err, localPath }, 'Could not remove ROM file');
	}
}

/**
 * Strips a 512-byte copier header if present, so a headered and an unheadered
 * dump of the same game produce the same CRC32 and match the same metadata.
 */
export function normaliseRom(data: Buffer): Buffer {
	return data.length % 1024 === 512 ? data.subarray(512) : data;
}

export function crc32(data: Buffer): string {
	let table = CRC_TABLE;
	if (!table) {
		table = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			table[i] = c >>> 0;
		}
		CRC_TABLE = table;
	}
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

let CRC_TABLE: Uint32Array | null = null;

/* ------------------------------------------------------------------- zip */

/**
 * Reads the first entry of a zip. Deliberately minimal - it handles the two
 * compression methods ROM archives actually use and refuses anything else,
 * rather than pulling in a dependency to be thorough about formats nobody
 * ships SNES ROMs in.
 */
function unzipFirstRom(buffer: Buffer): Buffer {
	if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50) {
		throw new Error('Not a valid zip file');
	}

	const method = buffer.readUInt16LE(8);
	const compressedSize = buffer.readUInt32LE(18);
	const nameLength = buffer.readUInt16LE(26);
	const extraLength = buffer.readUInt16LE(28);
	const start = 30 + nameLength + extraLength;

	if (compressedSize === 0) {
		throw new Error('This zip uses a streaming data descriptor; please upload the ROM directly');
	}

	const body = buffer.subarray(start, start + compressedSize);
	if (method === 0) return body;
	if (method === 8) return inflateRawSync(body);
	throw new Error(`Unsupported zip compression method ${method}`);
}

function zipEntryName(buffer: Buffer, fallback: string): string {
	try {
		const nameLength = buffer.readUInt16LE(26);
		const name = buffer.subarray(30, 30 + nameLength).toString('utf8');
		return name || fallback;
	} catch {
		return fallback;
	}
}
