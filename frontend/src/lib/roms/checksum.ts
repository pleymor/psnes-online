/**
 * Identifying a ROM by its contents.
 *
 * Once the files stay on the player's machine, the checksum is what ties a
 * local file to the game the server knows about - its title, its cover, its
 * saves - and what lets two players confirm they hold the same cartridge
 * before a netplay session starts. It is the identity of a game, so it has to
 * be computed the same way everywhere: same polynomial, same header handling.
 */

let table: Uint32Array | null = null;

export function crc32(data: Uint8Array): string {
	if (!table) {
		table = new Uint32Array(256);
		for (let i = 0; i < 256; i++) {
			let c = i;
			for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			table[i] = c >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	}
	return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

/**
 * Strips a 512-byte copier header if one is present.
 *
 * These are an artefact of 90s dumping hardware. Two dumps of one cartridge,
 * one headered and one not, are the same game and must produce the same
 * checksum - otherwise the same save file would not follow a player between
 * their two copies, and netplay would refuse a session over a difference that
 * does not exist.
 */
export function normaliseRom(data: Uint8Array): Uint8Array {
	return data.length % 1024 === 512 ? data.subarray(512) : data;
}

const ZIP_MAGIC = 0x04034b50;

export function isZip(data: Uint8Array): boolean {
	if (data.length < 4) return false;
	return new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) === ZIP_MAGIC;
}

const EOCD_MAGIC = 0x06054b50;
const CENTRAL_MAGIC = 0x02014b50;

/** What a ROM is called, so the right entry is picked out of an archive. */
const ROM_EXTENSIONS = ['.sfc', '.smc', '.fig', '.swc'];

interface ZipEntry {
	name: string;
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localOffset: number;
}

/**
 * Reads the archive's own index, which is at the end of the file.
 *
 * The local header in front of each entry is not a reliable description of it:
 * a tool that compresses on the fly cannot know the size or the CRC when it
 * writes that header, so it writes zeros there, sets bit 3, and repeats the
 * real values in a descriptor *after* the data. The central directory always
 * carries them - that is what it is for - which is why every real zip reader
 * starts from the end.
 *
 * Returns null when there is no directory to find, which is the honest answer
 * for something that is not a zip after all.
 */
function readCentralDirectory(data: Uint8Array): ZipEntry[] | null {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

	// The record is 22 bytes, plus a comment of up to 64KB which has to be
	// scanned past. Walking backwards finds the real one first.
	let eocd = -1;
	const earliest = Math.max(0, data.length - 22 - 0xffff);
	for (let at = data.length - 22; at >= earliest; at--) {
		if (view.getUint32(at, true) === EOCD_MAGIC) {
			eocd = at;
			break;
		}
	}
	if (eocd < 0) return null;

	const count = view.getUint16(eocd + 10, true);
	let at = view.getUint32(eocd + 16, true);
	const entries: ZipEntry[] = [];

	for (let i = 0; i < count; i++) {
		if (at + 46 > data.length || view.getUint32(at, true) !== CENTRAL_MAGIC) break;
		const nameLength = view.getUint16(at + 28, true);
		const extraLength = view.getUint16(at + 30, true);
		const commentLength = view.getUint16(at + 32, true);
		entries.push({
			name: new TextDecoder().decode(data.subarray(at + 46, at + 46 + nameLength)),
			method: view.getUint16(at + 10, true),
			compressedSize: view.getUint32(at + 20, true),
			uncompressedSize: view.getUint32(at + 24, true),
			localOffset: view.getUint32(at + 42, true)
		});
		at += 46 + nameLength + extraLength + commentLength;
	}

	return entries;
}

/**
 * The entry that is the ROM.
 *
 * "The first one" is wrong as soon as the archive keeps its contents in a
 * folder: the first entry is then the folder itself, zero bytes long. So the
 * extension decides, and failing that the largest entry - a ROM is by some
 * margin the biggest thing in a ROM archive.
 */
function pickRomEntry(entries: ZipEntry[]): ZipEntry | null {
	const files = entries.filter((e) => !e.name.endsWith('/') && e.uncompressedSize > 0);
	if (files.length === 0) return null;
	const named = files.find((e) => ROM_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext)));
	if (named) return named;
	return files.reduce((big, e) => (e.uncompressedSize > big.uncompressedSize ? e : big));
}

/**
 * Extracts the ROM from a zip.
 *
 * ROMs are very often kept zipped, and the lockstep core is a bare libretro
 * frontend with no archive support - it does not reject one either, it runs at
 * full speed and renders black, which is a miserable thing to debug. So this
 * happens as early as possible, before the bytes reach anything else.
 */
export async function unzipFirstEntry(data: Uint8Array): Promise<Uint8Array> {
	if (!isZip(data)) return data;

	const entries = readCentralDirectory(data);
	if (!entries) throw new Error('This file starts like a zip but has no directory of contents.');

	const entry = pickRomEntry(entries);
	if (!entry) throw new Error('This archive holds no file that could be a ROM.');

	// The local header repeats the name and may carry a different amount of
	// extra data than the central one, so its own lengths are what to skip.
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const nameLength = view.getUint16(entry.localOffset + 26, true);
	const extraLength = view.getUint16(entry.localOffset + 28, true);
	const start = entry.localOffset + 30 + nameLength + extraLength;

	const body = data.subarray(start, start + entry.compressedSize);
	if (entry.method === 0) return body;
	if (entry.method !== 8) throw new Error(`Unsupported zip compression method ${entry.method}.`);

	if (typeof DecompressionStream === 'undefined') {
		throw new Error('This browser cannot open zip archives; please unzip the ROM first.');
	}

	const stream = new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	const parts: Uint8Array[] = [];
	let total = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
		total += value.length;
	}

	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
