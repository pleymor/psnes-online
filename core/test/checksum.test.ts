/**
 * Tests for ROM identity.
 *
 * Once files stay on the player's machine, this checksum is what ties a local
 * file to the game the server knows about - its title, its cover, its saves -
 * and what lets two players confirm they hold the same cartridge. Get it wrong
 * and saves detach from their game, or netplay refuses a session over a
 * difference that does not exist.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { optional } from './skip.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { crc32, normaliseRom, isZip, unzipFirstEntry } from '../../frontend/src/lib/roms/checksum.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const romsDir = path.resolve(here, '..', '..', 'backend', 'roms');

test('the checksum matches the standard CRC32', () => {
	// "123456789" is the conventional CRC32 check vector.
	assert.equal(crc32(new TextEncoder().encode('123456789')), 'CBF43926');
	assert.equal(crc32(new Uint8Array(0)), '00000000');
});

test('a copier header does not change a game', () => {
	// The same cartridge dumped with and without a 512-byte header has to be
	// one game, or a player's saves would not follow their other copy.
	const body = new Uint8Array(64 * 1024);
	for (let i = 0; i < body.length; i++) body[i] = (i * 31) & 0xff;
	const headered = new Uint8Array(512 + body.length);
	headered.set(body, 512);

	assert.equal(normaliseRom(headered).length, body.length);
	assert.equal(crc32(normaliseRom(headered)), crc32(body));
});

test('a ROM of an exact bank size is left alone', () => {
	// 32KB banks with no remainder: stripping 512 bytes here would corrupt it.
	const rom = new Uint8Array(1024 * 1024).fill(0x42);
	assert.equal(normaliseRom(rom).length, rom.length);
});

test('recognises a zip without being fooled by a ROM', () => {
	assert.equal(isZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), true);
	assert.equal(isZip(new Uint8Array(1024).fill(0xff)), false);
	assert.equal(isZip(new Uint8Array(2)), false);
});

test('expands a deflated archive', async () => {
	// Built as a whole archive, directory and end record included. The fixture
	// this used to carry was a local header and a body and nothing else, which
	// is not a zip - it is the fragment the old reader happened to accept, and
	// writing it that way is how the reader's limitation went unnoticed.
	const rom = new Uint8Array(4096);
	for (let i = 0; i < rom.length; i++) rom[i] = (i * 7) & 0xff;

	const zip = buildZip([{ name: 'game.sfc', data: rom, deflate: true }]);

	const out = await unzipFirstEntry(zip);
	assert.deepEqual([...out], [...rom], 'the extracted ROM must be byte-identical');
});

test('leaves a plain ROM untouched', async () => {
	const rom = new Uint8Array(2048).fill(0x5a);
	assert.deepEqual([...(await unzipFirstEntry(rom))], [...rom]);
});

optional(
	existsSync(romsDir) && readdirSync(romsDir).some((f) => f.endsWith('.zip'))
		? false
		: 'no zipped ROM available locally'
)('a real zipped ROM identifies the same as its extracted form', async () => {
	const zipped = readdirSync(romsDir).find((f) => f.endsWith('.zip'))!;
	const data = new Uint8Array(readFileSync(path.join(romsDir, zipped)));

	assert.equal(isZip(data), true);
	const rom = await unzipFirstEntry(data);
	assert.ok(rom.length > 256 * 1024, `implausibly small: ${rom.length}`);

	// A whole number of 32KB banks once the header is off - the cheapest
	// structural check that we extracted a ROM and not something else.
	assert.equal(normaliseRom(rom).length % 32768, 0);

	// And the identity is stable across repeated reads.
	assert.equal(crc32(normaliseRom(rom)), crc32(normaliseRom(await unzipFirstEntry(data))));
});

/* --------------------------------------------- archives the reader must open */

/**
 * Builds a stored (uncompressed) zip, byte by byte.
 *
 * Built here rather than fetched, because what is being tested is a byte
 * layout: a fixture would hide which field makes the reader fail.
 */
function buildZip(
	entries: { name: string; data: Uint8Array; streamed?: boolean; deflate?: boolean }[]
): Uint8Array {
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = new TextEncoder().encode(entry.name);
		const body = entry.deflate
			? new Uint8Array(deflateRawSync(Buffer.from(entry.data)))
			: entry.data;
		const method = entry.deflate ? 8 : 0;
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(6, entry.streamed ? 0x0008 : 0, true); // bit 3: sizes come later
		lv.setUint16(8, method, true);
		// A streamed entry cannot know these yet, so it writes zeros and repeats
		// them in a descriptor after the data. This is the shape that failed.
		lv.setUint32(14, entry.streamed ? 0 : 0, true);
		lv.setUint32(18, entry.streamed ? 0 : body.length, true);
		lv.setUint32(22, entry.streamed ? 0 : entry.data.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);

		const descriptor = new Uint8Array(entry.streamed ? 16 : 0);
		if (entry.streamed) {
			const dv = new DataView(descriptor.buffer);
			dv.setUint32(0, 0x08074b50, true);
			dv.setUint32(8, body.length, true);
			dv.setUint32(12, entry.data.length, true);
		}

		const cd = new Uint8Array(46 + name.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(8, entry.streamed ? 0x0008 : 0, true); // flags
		cv.setUint16(10, method, true);
		cv.setUint32(20, body.length, true); // the real sizes always live here
		cv.setUint32(24, entry.data.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		cd.set(name, 46);
		central.push(cd);

		parts.push(local, body, descriptor);
		offset += local.length + body.length + descriptor.length;
	}

	const cdSize = central.reduce((n, c) => n + c.length, 0);
	const eocd = new Uint8Array(22);
	const ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);

	const all = [...parts, ...central, eocd];
	const total = all.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of all) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

test('a zip written as a stream opens, though its local header knows no sizes', async () => {
	// Any tool that compresses on the fly writes this: bit 3 set, sizes zero in
	// the local header and repeated in a descriptor after the data. Reading only
	// the local header, there is nothing to learn from - which is why the real
	// sizes are also in the central directory, and why that is what to read.
	const rom = new Uint8Array(2048).fill(0x5a);
	const zip = buildZip([{ name: 'game.sfc', data: rom, streamed: true }]);

	assert.deepEqual([...(await unzipFirstEntry(zip))], [...rom]);
});

test('a zip holding a folder yields the ROM inside it, not the folder', async () => {
	// The first entry of a zip is not the payload when the archive keeps its
	// contents in a directory: it is the directory, zero bytes long.
	const rom = new Uint8Array(1024).fill(0x17);
	const zip = buildZip([
		{ name: 'Super Butouden 2/', data: new Uint8Array(0) },
		{ name: 'Super Butouden 2/game.smc', data: rom }
	]);

	assert.deepEqual([...(await unzipFirstEntry(zip))], [...rom]);
});
