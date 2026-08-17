/**
 * Tests for how a ROM reaches the emulator.
 *
 * A zip that reaches the lockstep core does not fail loudly: snes9x loads the
 * bytes, runs at a full 60fps and renders black. That shipped to production
 * and cost an evening to find, because every observable counter looked
 * healthy. These check the shape of what comes out before it ever gets there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { crc32, normaliseRom } from '../../backend/src/services/rom-source.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const romsDir = path.resolve(here, '..', '..', 'backend', 'roms');

function findZip(): string | null {
	if (!existsSync(romsDir)) return null;
	const zip = readdirSync(romsDir).find((f) => f.toLowerCase().endsWith('.zip'));
	return zip ? path.join(romsDir, zip) : null;
}

const zipPath = findZip();
const needsZip = { skip: zipPath ? false : 'no zipped ROM available locally' };

test('a zip is recognised by its magic bytes', needsZip, () => {
	const data = readFileSync(zipPath!);
	assert.equal(data.readUInt32LE(0), 0x04034b50, 'the fixture must actually be a zip');

	// The check the read path performs. A raw ROM must not trip it.
	const rom = Buffer.alloc(1024, 0xff);
	assert.notEqual(rom.readUInt32LE(0), 0x04034b50);
});

test('a SNES ROM is recognisable after extraction, and a zip is not', needsZip, async () => {
	const { readRom } = await import('../../backend/src/services/rom-source.js');

	// A game whose file happens to be an archive, as Drive-backed games are.
	const game = { id: 'test', localPath: path.basename(zipPath!), driveFileId: null } as never;
	process.env.ROMS_DIR = romsDir;

	const out = await readRom(game, 'nobody');

	assert.notEqual(out.readUInt32LE(0), 0x04034b50, 'the archive must have been expanded');
	assert.ok(out.length > 256 * 1024, `implausibly small ROM: ${out.length} bytes`);

	// A SNES image is a whole number of 32KB banks, give or take a 512-byte
	// copier header - the cheapest structural check that we got a ROM and not
	// some other file from inside the archive.
	const body = normaliseRom(out);
	assert.equal(body.length % 32768, 0, `not a whole number of banks: ${body.length}`);
});

test('the checksum ignores a copier header', () => {
	// Headered and unheadered dumps of one game must land on the same metadata
	// entry, and count as the same ROM for the netplay handshake.
	const body = Buffer.alloc(64 * 1024, 0x5a);
	const headered = Buffer.concat([Buffer.alloc(512, 0), body]);

	assert.equal(normaliseRom(headered).length, body.length);
	assert.equal(crc32(normaliseRom(headered)), crc32(body));
});
