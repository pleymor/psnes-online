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

/**
 * Extracts the first entry of a zip.
 *
 * ROMs are very often kept zipped, and the lockstep core is a bare libretro
 * frontend with no archive support - it does not reject one either, it runs at
 * full speed and renders black, which is a miserable thing to debug. So this
 * happens as early as possible, before the bytes reach anything else.
 */
export async function unzipFirstEntry(data: Uint8Array): Promise<Uint8Array> {
	if (!isZip(data)) return data;

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const method = view.getUint16(8, true);
	const compressedSize = view.getUint32(18, true);
	const nameLength = view.getUint16(26, true);
	const extraLength = view.getUint16(28, true);
	const start = 30 + nameLength + extraLength;

	if (compressedSize === 0) {
		throw new Error('This archive stores its sizes in a trailing descriptor, which is unsupported.');
	}

	const body = data.subarray(start, start + compressedSize);
	if (method === 0) return body;
	if (method !== 8) throw new Error(`Unsupported zip compression method ${method}.`);

	if (typeof DecompressionStream === 'undefined') {
		throw new Error('This browser cannot open zip archives; please unzip the ROM first.');
	}

	const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
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
