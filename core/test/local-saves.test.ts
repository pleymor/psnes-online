/**
 * Les sauvegardes du joueur sans compte (#70) : quel fichier, où, et laquelle
 * croire.
 *
 * Chaque règle ici peut être fausse sans que rien ne se voie à l'écran. Un
 * mauvais nom de fichier, et la progression est écrite là où ni RetroArch ni
 * nous ne la relirons ; un mauvais repli, et un Firefox perd tout à chaque
 * fermeture d'onglet ; une mauvaise lecture, et la SRAM vierge d'une ROM
 * fraîchement chargée écrase la vraie.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
	deviceSaveKey,
	newestSave,
	romBaseName,
	saveDestination,
	saveFileName,
	saveNoteKey
} from '../../frontend/src/lib/saves/local-rules.js';
import {
	createLocalSaveStore,
	memoryDeviceSaves,
	memorySaveFolder,
	type DeviceSaves,
	type SaveFolder
} from '../../frontend/src/lib/saves/local-store.js';

const CRC = 'B19ED489';
const ROM = 'Super Mario World (U).sfc';
const bytes = (...values: number[]) => new Uint8Array(values);

/* ------------------------------------------------------------ les noms */

test('la SRAM part en .srm à côté de la ROM, sous le même nom', () => {
	// Le format de RetroArch, Snes9x et bsnes : c'est ce qui rend le fichier
	// utile hors d'ici.
	assert.equal(saveFileName(ROM, 'sram'), 'Super Mario World (U).srm');
});

test('les savestates sont numérotés .state1, .state2…', () => {
	assert.equal(saveFileName(ROM, 1), 'Super Mario World (U).state1');
	assert.equal(saveFileName(ROM, 3), 'Super Mario World (U).state3');
});

test('seule une extension de ROM est retirée, pas un point du titre', () => {
	assert.equal(romBaseName('Chrono Trigger v1.0.smc'), 'Chrono Trigger v1.0');
	assert.equal(romBaseName('game.ZIP'), 'game');
	// Pas d'extension de ROM : le nom reste entier plutôt que d'être tronqué.
	assert.equal(romBaseName('Super Mario World v1.0'), 'Super Mario World v1.0');
	// Un nom qui n'est qu'une extension ne devient pas vide.
	assert.equal(romBaseName('.sfc'), '.sfc');
});

test("la clé de l'appareil sépare la SRAM des savestates", () => {
	assert.notEqual(deviceSaveKey(CRC, 'sram'), deviceSaveKey(CRC, 1));
	assert.equal(deviceSaveKey(CRC, 2), `${CRC}:state2`);
});

/* ------------------------------------------------------- la destination */

const everything = { supported: true, folder: true, writeGranted: true, romFilename: ROM };

test('avec un dossier accessible en écriture et la ROM dedans, on écrit au dossier', () => {
	assert.deepEqual(saveDestination(everything), { kind: 'folder' });
});

test('chaque absence retombe sur le navigateur, avec sa raison', () => {
	assert.deepEqual(saveDestination({ ...everything, supported: false }), {
		kind: 'device',
		reason: 'unsupported'
	});
	assert.deepEqual(saveDestination({ ...everything, folder: false }), {
		kind: 'device',
		reason: 'no-folder'
	});
	assert.deepEqual(saveDestination({ ...everything, writeGranted: false }), {
		kind: 'device',
		reason: 'no-permission'
	});
	assert.deepEqual(saveDestination({ ...everything, romFilename: null }), {
		kind: 'device',
		reason: 'not-in-folder'
	});
});

test("l'API décide d'abord : un dossier mémorisé ne rend pas Firefox capable", () => {
	assert.deepEqual(saveDestination({ ...everything, supported: false, folder: true }), {
		kind: 'device',
		reason: 'unsupported'
	});
});

test('le panneau ROM dit où partent les sauvegardes', () => {
	assert.equal(saveNoteKey({ supported: true, folder: true, writeGranted: true }), 'localSavesInFolder');
	assert.equal(saveNoteKey({ supported: false, folder: false, writeGranted: false }), 'localSavesUnsupported');
	assert.equal(saveNoteKey({ supported: true, folder: false, writeGranted: false }), 'localSavesNoFolder');
	assert.equal(saveNoteKey({ supported: true, folder: true, writeGranted: false }), 'localSavesNoPermission');
});

/* ---------------------------------------------------- laquelle croire */

test('la copie la plus récente gagne, et le dossier à égalité', () => {
	const old = { bytes: bytes(1), savedAt: 100 };
	const recent = { bytes: bytes(2), savedAt: 200 };
	assert.equal(newestSave(old, recent)?.from, 'device');
	assert.equal(newestSave(recent, old)?.from, 'folder');
	assert.equal(newestSave(old, { ...old, bytes: bytes(9) })?.from, 'folder');
	assert.equal(newestSave(null, null), null);
	assert.equal(newestSave(null, old)?.from, 'device');
});

/* ------------------------------------------------------------ le magasin */

function clock(start = 1000) {
	let t = start;
	return () => (t += 10);
}

test('au dossier : la SRAM est écrite octet pour octet dans le .srm, et relue', async () => {
	const now = clock();
	const folder = memorySaveFolder({ roms: { [CRC]: ROM }, now });
	const device = memoryDeviceSaves();
	const store = createLocalSaveStore({ folder, device, now });

	const written = await store.write(CRC, 'sram', bytes(1, 2, 3));
	assert.deepEqual(written, { where: 'folder' });
	assert.deepEqual([...folder.files.get('Super Mario World (U).srm')!.bytes], [1, 2, 3]);
	assert.equal(device.entries.size, 0, 'rien dans le navigateur quand le dossier a pris');

	const read = await store.read(CRC, 'sram');
	assert.deepEqual([...read!.bytes], [1, 2, 3]);
	assert.equal(read!.from, 'folder');
});

test("sans permission d'écriture : repli silencieux sur le navigateur, et relu", async () => {
	const now = clock();
	const folder = memorySaveFolder({ roms: { [CRC]: ROM }, writeGranted: false, now });
	const device = memoryDeviceSaves();
	const store = createLocalSaveStore({ folder, device, now });

	assert.deepEqual(await store.write(CRC, 'sram', bytes(7)), { where: 'device', reason: 'no-permission' });
	assert.equal(folder.files.size, 0);
	assert.deepEqual([...(await store.read(CRC, 'sram'))!.bytes], [7]);
});

test('Firefox et Safari : tout vit dans le navigateur', async () => {
	const folder = memorySaveFolder({ supported: false, folder: false });
	const device = memoryDeviceSaves();
	const store = createLocalSaveStore({ folder, device });

	assert.deepEqual(await store.write(CRC, 2, bytes(4, 4)), { where: 'device', reason: 'unsupported' });
	assert.deepEqual([...(await store.read(CRC, 2))!.bytes], [4, 4]);
	assert.equal(await store.read(CRC, 'sram'), null, 'un emplacement jamais écrit est vide, pas une erreur');
});

test("un dossier qui refuse l'écriture ne perd pas la progression", async () => {
	const folder: SaveFolder = {
		...memorySaveFolder({ roms: { [CRC]: ROM } }),
		async writeFile() {
			throw new Error('disk full');
		}
	};
	const device = memoryDeviceSaves();
	const store = createLocalSaveStore({ folder, device });

	assert.deepEqual(await store.write(CRC, 'sram', bytes(5)), { where: 'device', reason: 'folder-failed' });
	assert.deepEqual([...(await store.read(CRC, 'sram'))!.bytes], [5]);
});

test('une copie plus récente dans le navigateur gagne sur un vieux .srm', async () => {
	// Le joueur a joué sans permission, puis a accordé l'écriture : le dossier
	// garde un ancien fichier, l'appareil la vraie progression.
	const now = clock();
	const folder = memorySaveFolder({ roms: { [CRC]: ROM }, now });
	await folder.writeFile('Super Mario World (U).srm', bytes(1));
	const device = memoryDeviceSaves();
	device.entries.set(deviceSaveKey(CRC, 'sram'), { bytes: bytes(2), savedAt: 10_000 });
	const store = createLocalSaveStore({ folder, device, now });

	const read = await store.read(CRC, 'sram');
	assert.deepEqual([...read!.bytes], [2]);
	assert.equal(read!.from, 'device');
});

test("une lecture qui échoue LÈVE : c'est ce qui interdit d'écrire par-dessus", async () => {
	// Rendre null ici ferait croire à une première partie, et la SRAM vierge
	// partirait écraser celle qu'on n'a pas su lire.
	const broken: DeviceSaves = {
		async get() {
			throw new Error('database blocked');
		},
		async put() {}
	};
	const store = createLocalSaveStore({ folder: memorySaveFolder({ supported: false }), device: broken });
	await assert.rejects(() => store.read(CRC, 'sram'));
});

test("l'écriture copie les octets : la mémoire du cœur peut changer entre-temps", async () => {
	const device = memoryDeviceSaves();
	const store = createLocalSaveStore({ folder: memorySaveFolder({ supported: false }), device });
	const live = bytes(1, 1);
	await store.write(CRC, 'sram', live);
	live[0] = 99;
	assert.deepEqual([...(await store.read(CRC, 'sram'))!.bytes], [1, 1]);
});

test('lister rend les emplacements occupés, SRAM comprise, dans l’ordre', async () => {
	const now = clock();
	const folder = memorySaveFolder({ roms: { [CRC]: ROM }, now });
	const store = createLocalSaveStore({ folder, device: memoryDeviceSaves(), now });
	await store.write(CRC, 3, bytes(3));
	await store.write(CRC, 'sram', bytes(0));
	await store.write(CRC, 1, bytes(1));

	assert.deepEqual(
		(await store.list(CRC)).map((s) => s.slot),
		['sram', 1, 3]
	);
	assert.deepEqual(await store.list('OTHER000'), []);
});

test("un dossier dont la lecture n'est pas accordée n'est pas lu, il n'est pas demandé", async () => {
	const folder = memorySaveFolder({ roms: { [CRC]: ROM }, readGranted: false });
	await folder.writeFile('Super Mario World (U).srm', bytes(1));
	const store = createLocalSaveStore({ folder, device: memoryDeviceSaves() });
	assert.equal(await store.read(CRC, 'sram'), null);
});
