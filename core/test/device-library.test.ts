/**
 * Quels jeux du compte cet appareil peut réellement ouvrir.
 *
 * Une fonction pure sur deux listes, testée sans DOM comme le reste de
 * `roms/` : c'est la seule règle qui décide de ce que le joueur voit, et se
 * tromper ici fait disparaître des jeux qu'il possède.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { deviceLibrary } from '../../frontend/src/lib/roms/device-library.js';

const smw = { id: '1', title: 'Super Mario World', crc32: 'aaaa1111' };
const som = { id: '2', title: 'Secret of Mana', crc32: 'bbbb2222' };
const zelda = { id: '3', title: 'A Link to the Past', crc32: 'cccc3333' };

test('un appareil ne montre que ce dont il a les octets', () => {
	const shown = deviceLibrary([smw, som, zelda], ['aaaa1111', 'cccc3333']);
	assert.deepEqual(
		shown.map((g) => g.id),
		['1', '3']
	);
});

test('un appareil sans rien de résoluble montre une bibliothèque vide', () => {
	assert.deepEqual(deviceLibrary([smw, som], []), []);
});

test('un compte vide reste vide, quoi que porte l appareil', () => {
	assert.deepEqual(deviceLibrary([], ['aaaa1111']), []);
});

test("l ordre du compte est conservé : le tri est décidé ailleurs", () => {
	const shown = deviceLibrary([zelda, smw], ['aaaa1111', 'cccc3333']);
	assert.deepEqual(
		shown.map((g) => g.id),
		['3', '1']
	);
});

test('un jeu sans checksum reste visible, parce qu il est réparable', () => {
	// `Game.crc32` est nullable : les entrées créées avant les ROMs locales
	// n'ont pas d'identité, et `needsIdentification` existe pour que le joueur
	// la leur donne. Les masquer supprimerait le seul endroit d'où on peut les
	// rattacher - elles ne sont pas "absentes de cet appareil", elles sont "pas
	// encore identifiées", ce qui est un problème de compte et non d'appareil.
	const orphan = { id: '4', title: 'Inconnu', crc32: null };
	const shown = deviceLibrary([smw, orphan], ['aaaa1111']);
	assert.deepEqual(
		shown.map((g) => g.id),
		['1', '4']
	);
});

test('un checksum absent du compte ne fabrique pas de jeu', () => {
	const shown = deviceLibrary([smw], ['aaaa1111', 'ffff9999']);
	assert.equal(shown.length, 1);
});
