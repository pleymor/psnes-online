/**
 * Les ROMs qu'un appareil garde parce que le joueur les lui a désignées.
 *
 * L'implémentation de production parle à IndexedDB, qui n'existe pas ici ; ce
 * qui est testé est le contrat, contre l'implémentation mémoire que la
 * production et les tests partagent. Un contrat qui diverge de son
 * implémentation réelle est un piège, donc les deux sont construites côte à
 * côte dans le même fichier.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { memoryKeptFiles, keptFilesAvailable } from '../../frontend/src/lib/roms/kept-files.js';

const bytes = (seed: number) => new Uint8Array([seed, seed + 1, seed + 2]);

test('ce qui a été gardé se relit à l identique', async () => {
	const store = memoryKeptFiles();
	await store.keep('aaaa1111', bytes(10));
	assert.deepEqual([...(await store.read('aaaa1111'))!], [10, 11, 12]);
});

test('un checksum jamais gardé se lit null, pas une exception', async () => {
	const store = memoryKeptFiles();
	assert.equal(await store.read('inconnu'), null);
});

test('les checksums gardés se listent, parce que la bibliothèque en dépend', async () => {
	const store = memoryKeptFiles();
	await store.keep('aaaa1111', bytes(1));
	await store.keep('bbbb2222', bytes(2));
	assert.deepEqual((await store.checksums()).sort(), ['aaaa1111', 'bbbb2222']);
});

test('garder deux fois le même checksum ne le duplique pas', async () => {
	const store = memoryKeptFiles();
	await store.keep('aaaa1111', bytes(1));
	await store.keep('aaaa1111', bytes(9));
	assert.deepEqual(await store.checksums(), ['aaaa1111']);
	assert.deepEqual([...(await store.read('aaaa1111'))!], [9, 10, 11], 'la dernière copie gagne');
});

test('oublier retire des deux vues à la fois', async () => {
	const store = memoryKeptFiles();
	await store.keep('aaaa1111', bytes(1));
	await store.forget('aaaa1111');
	assert.equal(await store.read('aaaa1111'), null);
	assert.deepEqual(await store.checksums(), []);
});

test('oublier ce qui n existe pas ne lève pas', async () => {
	const store = memoryKeptFiles();
	await assert.doesNotReject(() => store.forget('jamais-vu'));
});

test('sans IndexedDB, le stockage se déclare indisponible', () => {
	// Sous node il n'y en a pas. La question doit répondre non plutôt que de
	// lever, parce que l'appelant s'en sert pour décider s'il tente le store.
	assert.equal(keptFilesAvailable(), false);
});
