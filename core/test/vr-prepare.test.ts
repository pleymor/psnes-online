/**
 * Bringing the games onto the device before the headset takes over.
 *
 * The law this serves was measured on a real Quest 3, not reasoned out:
 * reading the folder from inside an immersive session never succeeds. The
 * permission granted on the flat page is real, and `queryPermission` still
 * answers "not granted" once the session is running - cleanly, which is why
 * the panel reports `no-permission` rather than an error. Two fixes were built
 * on the assumption that this was repairable and neither changed the report.
 *
 * So the reading happens on the flat page, from the press that opens VR. Two
 * rules here are load-bearing.
 *
 * Nothing may bar the door. A device that cannot say what it holds, a folder
 * that has gone away, a cartridge that will not read - none of them is allowed
 * to stop somebody entering VR. The worst outcome is the notice on the library
 * panel, which is survivable.
 *
 * And one bad cartridge must not cost the player the other thirty-nine. A loop
 * that stops at the first failure would leave a library half prepared with no
 * way to tell which half.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
	missingFromDevice,
	prepareForVr,
	type PreparePorts
} from '../../frontend/src/lib/vr/prepare.js';

const HANDLE = {} as FileSystemDirectoryHandle;

function ports(over: Partial<PreparePorts> = {}): PreparePorts {
	return {
		keptChecksums: async () => [],
		// The fixture's whole universe: every checksum these tests name is in
		// this device's folder unless a test says otherwise.
		folderChecksums: async () => ['aaa', 'bbb', 'ccc', 'ddd'],
		scanFolder: async () => ['aaa', 'bbb', 'ccc', 'ddd'],
		storedDirectory: async () => HANDLE,
		readAndKeep: async () => new Uint8Array([1]),
		...over
	};
}

test('what is missing is what the device does not already hold', async () => {
	const p = ports({ keptChecksums: async () => ['aaa', 'ccc'] });
	assert.deepEqual(await missingFromDevice(['aaa', 'bbb', 'ccc', 'ddd'], p), ['bbb', 'ddd']);
});

test('a device that cannot say what it holds does not bar the door', async () => {
	// A wrong "nothing missing" costs the panel notice, which is survivable.
	// A wrong "something missing" would stop somebody entering VR.
	const p = ports({ keptChecksums: async () => { throw new Error('indexeddb blocked'); } });
	assert.deepEqual(await missingFromDevice(['aaa'], p), []);
});

test('a game already on the device is not read again', async () => {
	let read = 0;
	const p = ports({
		keptChecksums: async () => ['aaa'],
		readAndKeep: async () => { read++; return new Uint8Array([1]); }
	});

	assert.deepEqual(await prepareForVr(['aaa'], p), { prepared: 0, failed: 0 });
	assert.equal(read, 0, 'a kept ROM needs no folder at all');
});

test('the scan decides what is attempted, never the index', async () => {
	/*
	 * The bug this pins. A headset reported "11/11 games could not be read"
	 * over a folder holding six: the index still described an older folder,
	 * every entry missed, and the warning counted them all. Anything the
	 * folder does not hold is not work that failed - it is work that was
	 * never possible.
	 */
	const read: string[] = [];
	const p = ports({
		folderChecksums: async () => ['stale1', 'stale2', 'aaa'],
		scanFolder: async () => ['aaa'],
		readAndKeep: async (_h, checksum) => { read.push(checksum); return new Uint8Array([1]); }
	});

	assert.deepEqual(
		await prepareForVr(['stale1', 'stale2', 'aaa'], p),
		{ prepared: 1, failed: 0 },
		'the two the folder does not hold must not be counted as failures'
	);
	assert.deepEqual(read, ['aaa']);
});

test('a folder that cannot be scanned is a no-op, not a failure', async () => {
	const p = ports({ scanFolder: async () => { throw new Error('permission gone'); } });
	assert.deepEqual(await prepareForVr(['aaa'], p), { prepared: 0, failed: 0 });
});

test('every missing game is read and kept', async () => {
	const read: string[] = [];
	const p = ports({
		keptChecksums: async () => ['aaa'],
		readAndKeep: async (_h, checksum) => { read.push(checksum); return new Uint8Array([1]); }
	});

	assert.deepEqual(await prepareForVr(['aaa', 'bbb', 'ccc'], p), { prepared: 2, failed: 0 });
	assert.deepEqual(read, ['bbb', 'ccc'], 'only the ones the device lacked');
});

test('one unreadable cartridge does not cost the player the rest', async () => {
	// Renamed, deleted, or on a disk that hiccuped. Stopping here would leave
	// the library half prepared with no way to tell which half.
	const p = ports({
		readAndKeep: async (_h, checksum) => (checksum === 'bbb' ? null : new Uint8Array([1]))
	});

	assert.deepEqual(await prepareForVr(['aaa', 'bbb', 'ccc'], p), { prepared: 2, failed: 1 });
});

test('a read that throws is counted, not propagated', async () => {
	const p = ports({
		readAndKeep: async (_h, checksum) => {
			if (checksum === 'bbb') throw new Error('the disk went away');
			return new Uint8Array([1]);
		}
	});

	assert.deepEqual(await prepareForVr(['aaa', 'bbb', 'ccc'], p), { prepared: 2, failed: 1 });
});

test('no folder is an ordinary state, not a failure', async () => {
	// A device that keeps its games another way has nothing to read and
	// nothing to report - and must not be told it failed.
	const p = ports({ storedDirectory: async () => undefined });
	assert.deepEqual(await prepareForVr(['aaa'], p), { prepared: 0, failed: 0 });
});

test('a folder that throws does not bar the door either', async () => {
	const p = ports({ storedDirectory: async () => { throw new Error('handle revoked'); } });
	assert.deepEqual(await prepareForVr(['aaa'], p), { prepared: 0, failed: 0 });
});

test('progress is reported once per game, including the failures', async () => {
	// The player is watching a bar that must not stall on a bad cartridge.
	const steps: Array<[number, number]> = [];
	const p = ports({
		readAndKeep: async (_h, checksum) => (checksum === 'bbb' ? null : new Uint8Array([1]))
	});

	await prepareForVr(['aaa', 'bbb', 'ccc'], p, (done, total) => steps.push([done, total]));
	assert.deepEqual(steps, [[1, 3], [2, 3], [3, 3]]);
});

test('un jeu absent de CE dossier n est pas du travail à faire', async () => {
	/*
	 * La bibliothèque vient du serveur et couvre tous les appareils du joueur,
	 * donc l'essentiel n'est pas dans ce dossier-ci. Les compter faisait de
	 * chacun un échec permanent - et tant que la préparation gardait la porte,
	 * un échec permanent était un verrou : les deux messages revenaient à
	 * chaque pression et la session ne s'ouvrait jamais. Livré comme ça.
	 */
	const p = ports({ folderChecksums: async () => ['aaa'] });
	assert.deepEqual(
		await missingFromDevice(['aaa', 'surPC', 'surPortable'], p),
		['aaa'],
		'seuls les jeux que ce dossier prétend avoir peuvent être préparés'
	);
});

test('une bibliothèque entièrement ailleurs ne demande aucune préparation', async () => {
	// Le cas du casque dont le dossier est vide : rien à faire, et surtout pas
	// une pression qui ne prépare rien indéfiniment. Les deux sources doivent
	// être vides - l'index pour ne pas proposer la pression, le scan pour ne
	// rien tenter si elle a lieu quand même.
	const p = ports({ folderChecksums: async () => [], scanFolder: async () => [] });
	assert.deepEqual(await missingFromDevice(['aaa', 'bbb'], p), []);
	assert.deepEqual(await prepareForVr(['aaa', 'bbb'], p), { prepared: 0, failed: 0 });
});

test('un index de dossier illisible ne barre pas la porte', async () => {
	const p = ports({ folderChecksums: async () => { throw new Error('index illisible'); } });
	assert.deepEqual(await missingFromDevice(['aaa'], p), []);
});
