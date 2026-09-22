/**
 * Ce que coûte de retrouver une ROM dans le dossier du joueur.
 *
 * Deux dépenses que rien ne mesurait : le nombre de fichiers effectivement LUS
 * - chacun est un `getFile()` suivi d'un CRC32 sur des mégaoctets - et le
 * nombre d'écritures dans l'index, chacune étant une connexion IndexedDB
 * ouverte et refermée.
 *
 * Ces tests posent la LIGNE DE BASE, c'est-à-dire ce que le code coûte
 * aujourd'hui. Ils sont écrits avant d'y toucher, exprès : sans eux, un « c'est
 * plus rapide » n'aurait rien à quoi se comparer, et un test de coût qui ne
 * compte rien ne peut pas échouer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	scanDirectory,
	readRomByChecksum,
	reportFolderCost,
	type FolderCost,
	type FolderIndex
} from '../../frontend/src/lib/roms/local-library.js';
import { crc32, normaliseRom } from '../../frontend/src/lib/roms/checksum.js';

/** Une ROM plausible : 32 Ko, sans en-tête de copieur, au contenu distinct. */
function rom(seed: number): Uint8Array {
	const bytes = new Uint8Array(32 * 1024);
	for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 7 + i * 31) & 0xff;
	return bytes;
}

interface Counting {
	handle: FileSystemDirectoryHandle;
	/** Combien de fichiers ont été réellement ouverts et lus. */
	reads(): number;
}

/**
 * Un dossier de ROMs qui compte ce qu'on lui prend.
 *
 * L'énumération des NOMS est gratuite et ne compte pas : c'est `getFile()` qui
 * coûte, parce que c'est lui qui donne les octets à hacher.
 */
function folder(files: Array<{ name: string; bytes: Uint8Array }>): Counting {
	let reads = 0;
	const fileHandle = (name: string, bytes: Uint8Array) => ({
		kind: 'file' as const,
		name,
		async getFile() {
			reads += 1;
			return new File([bytes as BlobPart], name);
		}
	});

	const handle = {
		[Symbol.asyncIterator]: async function* () {
			for (const f of files) yield [f.name, fileHandle(f.name, f.bytes)] as const;
		},
		async getFileHandle(name: string) {
			const found = files.find(f => f.name === name);
			if (!found) throw new Error(`NotFoundError: ${name}`);
			return fileHandle(name, found.bytes);
		}
	};

	return { handle: handle as unknown as FileSystemDirectoryHandle, reads: () => reads };
}

interface CountingIndex extends FolderIndex {
	/** Combien de fois l'index a été écrit. */
	writes(): number;
}

function memoryIndex(seed: Record<string, string> = {}): CountingIndex {
	const byChecksum = new Map(Object.entries(seed));
	let writes = 0;
	return {
		async filenameFor(checksum) {
			return byChecksum.get(checksum) ?? null;
		},
		async remember(checksum, filename) {
			writes += 1;
			byChecksum.set(checksum, filename);
		},
		async checksums() {
			return [...byChecksum.keys()];
		},
		async forget(checksum) {
			byChecksum.delete(checksum);
		},
		writes: () => writes
	};
}

const ROMS = [0, 1, 2, 3, 4].map(seed => ({
	name: `jeu-${seed}.sfc`,
	bytes: rom(seed),
	checksum: crc32(normaliseRom(rom(seed)))
}));

test('retrouver une ROM par balayage lit tout le dossier, où qu\'elle soit', () => {
	// La ligne de base. La deuxième cartouche sur cinq, et les cinq sont lues :
	// `readRomByChecksum` attend le balayage COMPLET avant de regarder ce qu'il
	// a trouvé, si bien que sa sortie anticipée ne fait rien gagner.
	return (async () => {
		const dossier = folder(ROMS);
		const wanted = ROMS[1];

		const bytes = await readRomByChecksum(dossier.handle, wanted.checksum, memoryIndex());

		assert.deepEqual(bytes && [...bytes], [...wanted.bytes]);
		assert.equal(dossier.reads(), ROMS.length + 1,
			'les cinq du balayage, plus la relecture du fichier trouvé');
	})();
});

test('le nom mémorisé, lui, évite le balayage entièrement', async () => {
	const dossier = folder(ROMS);
	const wanted = ROMS[4];
	const index = memoryIndex({ [wanted.checksum]: wanted.name });

	const bytes = await readRomByChecksum(dossier.handle, wanted.checksum, index);

	assert.deepEqual(bytes && [...bytes], [...wanted.bytes]);
	assert.equal(dossier.reads(), 1);
});

test('un nom mémorisé qui ne vaut plus rien est retiré quand rien ne le remplace', async () => {
	// Le fichier a été renommé hors du navigateur : le nom mémorisé ne s'ouvre
	// plus, et le balayage ne trouve pas ce checksum non plus. L'entrée périmée
	// doit partir - c'est le seul moment où son erreur a coûté quelque chose.
	const dossier = folder(ROMS);
	const index = memoryIndex({ 'DEADBEEF': 'disparu.sfc' });

	assert.equal(await readRomByChecksum(dossier.handle, 'DEADBEEF', index), null);

	assert.equal(await index.filenameFor('DEADBEEF'), null);
});

test('un balayage écrit dans l\'index une fois par cartouche', async () => {
	// L'autre moitié de la ligne de base : cinq écritures pour cinq ROMs, et
	// chacune ouvre et referme la base.
	const dossier = folder(ROMS);
	const index = memoryIndex();

	const entries = await scanDirectory(dossier.handle, index);

	assert.equal(entries.length, ROMS.length);
	assert.equal(index.writes(), ROMS.length);
});

test('un dossier sans ROM n\'écrit rien', async () => {
	const dossier = folder([{ name: 'notes.txt', bytes: new Uint8Array(4) }]);
	const index = memoryIndex();

	assert.deepEqual(await scanDirectory(dossier.handle, index), []);
	assert.equal(index.writes(), 0);
});

/*
 * L'instrument lui-même.
 *
 * `local-library.ts` et `provider.ts` refusent tous les deux le logger, pour
 * tourner sous node dans cette suite - l'en-tête de `provider.ts` le dit en
 * toutes lettres. Le coût sort donc par un rapporteur que l'application branche
 * une fois, et que les tests laissent à null.
 */
test('le coût de la résolution est rapporté : par quel chemin, et combien de fichiers lus', async () => {
	const seen: FolderCost[] = [];
	reportFolderCost(cost => void seen.push(cost));
	try {
		const dossier = folder(ROMS);
		const wanted = ROMS[2];

		await readRomByChecksum(dossier.handle, wanted.checksum, memoryIndex());
		await readRomByChecksum(
			dossier.handle, wanted.checksum, memoryIndex({ [wanted.checksum]: wanted.name })
		);

		assert.equal(seen.length, 2);
		assert.equal(seen[0].path, 'scan');
		assert.equal(seen[0].filesRead, ROMS.length, 'tout le dossier, quelle que soit la cartouche');
		assert.equal(seen[1].path, 'remembered');
		assert.equal(seen[1].filesRead, 1);
		// La durée est mesurée, pas inventée : elle ne peut pas être négative et
		// c'est tout ce qu'un test peut honnêtement en dire.
		for (const cost of seen) assert.ok(cost.ms >= 0);
	} finally {
		// `bun test` partage le processus entre les fichiers : un rapporteur
		// laissé en place suivrait les autres suites.
		reportFolderCost(null);
	}
});
