/**
 * Tests for resolving a game to the bytes on the player's own machine.
 *
 * The failure this guards against is quiet and expensive: a player points at a
 * ROM that is the right game but the wrong dump, the emulator starts happily,
 * and lockstep desynchronises seconds later with nothing in the logs to say
 * why. So nothing is accepted on the strength of its filename - the contents
 * are hashed and compared, every time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { crc32, normaliseRom } from '../../frontend/src/lib/roms/checksum.js';

// The provider reaches for the logger and IndexedDB, neither of which exist
// here; it is imported lazily inside each test so the module graph stays small.
async function provider() {
	return import('../../frontend/src/lib/roms/provider.js');
}

function rom(seed: number, size = 4096): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = (i * seed) & 0xff;
	return bytes;
}

function asFile(bytes: Uint8Array, name = 'game.sfc'): File {
	return new File([bytes], name);
}

test('a remembered ROM is found again by its checksum', async () => {
	const { remember, isCached, resolveQuietly } = await provider();
	const bytes = rom(13);

	const checksum = remember(bytes);
	assert.equal(checksum, crc32(bytes), 'the key must be what the file contains');
	assert.equal(isCached(checksum), true);
	assert.deepEqual([...(await resolveQuietly(checksum))!], [...bytes]);
});

test('an unknown checksum resolves to nothing rather than throwing', async () => {
	// This is the normal state for a guest on a fresh browser, not an error:
	// the caller's job is then to ask the player where the file is.
	const { resolveQuietly } = await provider();
	assert.equal(await resolveQuietly('DEADBEEF'), null);
});

test('a file matching the expected dump is accepted', async () => {
	const { offerFile, isCached } = await provider();
	const bytes = rom(7);
	const checksum = crc32(bytes);

	const accepted = await offerFile(asFile(bytes), checksum);

	assert.deepEqual([...accepted], [...bytes]);
	assert.equal(isCached(checksum), true, 'and is kept for the rest of the session');
});

test('a different dump of the same game is refused', async () => {
	const { offerFile, isCached } = await provider();
	const wanted = crc32(rom(3));
	const other = rom(4);

	await assert.rejects(
		() => offerFile(asFile(other, 'Secret of Mana (U).sfc'), wanted),
		/different dump/,
		'a plausible filename must not be enough to get in'
	);
	assert.equal(isCached(wanted), false, 'and nothing is cached under the checksum it is not');
});

test('a headered copy of the same cartridge is accepted', async () => {
	// The two dumps differ byte for byte but are one game, and a player whose
	// copy carries a copier header must still be able to join.
	const { offerFile } = await provider();
	const body = rom(11, 64 * 1024);
	const headered = new Uint8Array(512 + body.length);
	headered.set(body, 512);

	const accepted = await offerFile(asFile(headered), crc32(body));

	assert.equal(normaliseRom(accepted).length, body.length);
	assert.deepEqual([...normaliseRom(accepted)], [...body]);
});

/* --------------------------------------------- les fichiers gardés */

test('un fichier accepté est gardé pour les prochaines fois', async () => {
	const { offerFile, useKeptFiles } = await provider();
	const { memoryKeptFiles } = await import('../../frontend/src/lib/roms/kept-files.js');
	const kept = memoryKeptFiles();
	useKeptFiles(kept);

	const bytes = rom(21);
	const checksum = crc32(normaliseRom(bytes));
	await offerFile(asFile(bytes), checksum);

	assert.deepEqual(await kept.checksums(), [checksum]);
	useKeptFiles(null);
});

test('un fichier refusé n est pas gardé', async () => {
	// Garder une ROM qui ne correspond pas au jeu demandé la rendrait résoluble
	// et injouable : la bibliothèque l'annoncerait et le lancement échouerait.
	const { offerFile, useKeptFiles } = await provider();
	const { memoryKeptFiles } = await import('../../frontend/src/lib/roms/kept-files.js');
	const kept = memoryKeptFiles();
	useKeptFiles(kept);

	await assert.rejects(() => offerFile(asFile(rom(22)), 'ffffffff'));
	assert.deepEqual(await kept.checksums(), []);
	useKeptFiles(null);
});

test('les octets gardés se retrouvent sans rien demander au joueur', async () => {
	const { resolveQuietly, useKeptFiles } = await provider();
	const { memoryKeptFiles } = await import('../../frontend/src/lib/roms/kept-files.js');
	const kept = memoryKeptFiles();
	const bytes = rom(23);
	const checksum = crc32(normaliseRom(bytes));
	await kept.keep(checksum, bytes);
	useKeptFiles(kept);

	assert.deepEqual([...(await resolveQuietly(checksum))!], [...bytes]);
	useKeptFiles(null);
});

test('ce que l appareil sait ouvrir inclut les fichiers gardés', async () => {
	const { resolvableHere, useKeptFiles } = await provider();
	const { memoryKeptFiles } = await import('../../frontend/src/lib/roms/kept-files.js');
	const kept = memoryKeptFiles();
	await kept.keep('aaaa1111', rom(24));
	useKeptFiles(kept);

	assert.deepEqual(await resolvableHere(), ['aaaa1111']);
	useKeptFiles(null);
});
