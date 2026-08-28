/**
 * Filtrer sa propre bibliothèque ne doit jamais fermer la partie d'un autre.
 *
 * C'est la régression qui rendrait ce travail nuisible : masquer un jeu parce
 * que cet appareil n'en a pas les octets est une décision d'affichage, et le
 * chemin qui rejoint la partie d'un ami passe par un checksum reçu, pas par la
 * bibliothèque. Ce test épingle cette séparation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deviceLibrary } from '../../frontend/src/lib/roms/device-library.js';
import { crc32, normaliseRom } from '../../frontend/src/lib/roms/checksum.js';

function rom(seed: number, size = 4096): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = (i * seed) & 0xff;
	return bytes;
}

test('un jeu invisible dans la bibliothèque reste jouable en invité', async () => {
	const { remember, isCached, resolveQuietly, resolvableHere, useKeptFiles } = await import(
		'../../frontend/src/lib/roms/provider.js'
	);
	const { memoryKeptFiles } = await import('../../frontend/src/lib/roms/kept-files.js');

	const kept = memoryKeptFiles();
	useKeptFiles(kept);

	const bytes = rom(31);
	const checksum = crc32(normaliseRom(bytes));

	// Cet appareil ne possède pas ce jeu : il n'apparaît pas dans sa bibliothèque.
	const library = deviceLibrary([{ id: '9', title: 'Le jeu de l ami', crc32: checksum }], []);
	assert.deepEqual(library, [], 'absent de la bibliothèque de cet appareil');

	// L'hôte le lui envoie pendant la partie. Le chemin de jeu passe par le
	// cache de session, que la bibliothèque ignore délibérément.
	remember(bytes);
	assert.equal(isCached(checksum), true);
	assert.deepEqual([...(await resolveQuietly(checksum))!], [...bytes], 'la partie peut démarrer');

	// Et recevoir n'est toujours pas posséder : la partie finie, cet appareil ne
	// prétend pas savoir ouvrir ce jeu, et rien n'a été écrit dans ce qu'il garde.
	// C'est la moitié de la propriété qu'une régression silencieuse casserait,
	// puisqu'un `keep()` de trop ne ferait échouer aucun autre test.
	assert.equal(
		(await resolvableHere()).includes(checksum),
		false,
		'un jeu reçu n entre pas dans la bibliothèque de cet appareil'
	);
	assert.deepEqual(await kept.checksums(), [], 'et rien n a été gardé sur le disque');

	useKeptFiles(null);
});
