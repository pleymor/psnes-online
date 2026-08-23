/**
 * A real PNG, built rather than pasted.
 *
 * Written after a hand-copied base64 "1x1 png" turned out to be undecodable:
 * the server accepted it, because it only reads the header bytes, and the
 * browser's `<img>` rendered something, but `createImageBitmap` refused it with
 * "the source image could not be decoded" - so a cover test using it failed for
 * a reason that had nothing to do with the code under test. Building the file
 * with correct chunk CRCs means the fixture can never be the suspect.
 */

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let c = -1;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/** A truecolour gradient of the given size: a decodable picture, not a placeholder. */
export function makePng(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type 2: truecolour RGB

	const raw = Buffer.alloc(height * (1 + width * 3));
	let p = 0;
	for (let y = 0; y < height; y++) {
		raw[p++] = 0; // filter type: none
		for (let x = 0; x < width; x++) {
			raw[p++] = Math.round((x * 255) / Math.max(1, width - 1));
			raw[p++] = Math.round((y * 255) / Math.max(1, height - 1));
			raw[p++] = 128;
		}
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}
