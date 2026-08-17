/**
 * Tests for ROM identity.
 *
 * Once files stay on the player's machine, this checksum is what ties a local
 * file to the game the server knows about - its title, its cover, its saves -
 * and what lets two players confirm they hold the same cartridge. Get it wrong
 * and saves detach from their game, or netplay refuses a session over a
 * difference that does not exist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
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
	const rom = new Uint8Array(4096);
	for (let i = 0; i < rom.length; i++) rom[i] = (i * 7) & 0xff;

	const name = new TextEncoder().encode('game.sfc');
	const body = new Uint8Array(deflateRawSync(Buffer.from(rom)));
	const header = new Uint8Array(30 + name.length);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x04034b50, true);
	view.setUint16(8, 8, true); // deflate
	view.setUint32(18, body.length, true);
	view.setUint16(26, name.length, true);
	header.set(name, 30);

	const zip = new Uint8Array(header.length + body.length);
	zip.set(header);
	zip.set(body, header.length);

	const out = await unzipFirstEntry(zip);
	assert.deepEqual([...out], [...rom], 'the extracted ROM must be byte-identical');
});

test('leaves a plain ROM untouched', async () => {
	const rom = new Uint8Array(2048).fill(0x5a);
	assert.deepEqual([...(await unzipFirstEntry(rom))], [...rom]);
});

test('a real zipped ROM identifies the same as its extracted form', {
	skip: existsSync(romsDir) && readdirSync(romsDir).some((f) => f.endsWith('.zip'))
		? false
		: 'no zipped ROM available locally'
}, async () => {
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
