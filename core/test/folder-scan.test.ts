/**
 * Ce que coûte de retrouver une ROM dans le dossier du joueur.
 *
 * Deux dépenses, et aucune des deux ne se voyait dans un test : le nombre de
 * fichiers effectivement LUS - chacun est un `getFile()` suivi d'un CRC32 sur
 * des mégaoctets - et le nombre d'écritures dans l'index. `readRomByChecksum`
 * attendait le balayage complet avant même de regarder s'il avait trouvé, si
 * bien que sa sortie anticipée ne faisait rien gagner ; et le balayage ouvrait
 * et refermait IndexedDB une fois par cartouche.
 *
 * Ces tests comptent. Un test de coût qui ne compte rien ne peut pas échouer,
 * et c'est exactement ce qui a laissé ces deux dépenses s'installer.
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
	/** Combien de fois l'index a été écrit, tous enregistrements confondus. */
	writes(): number;
}

function memoryIndex(seed: Record<string, string> = {}): CountingIndex {
	const byChecksum = new Map(Object.entries(seed));
	let writes = 0;
	return {
		async filenameFor(checksum) {
			return byChecksum.get(checksum) ?? null;
		},
		async remember(entries) {
			writes += 1;
			for (const e of entries) byChecksum.set(e.checksum, e.filename);
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

test('une ROM trouvée tôt ne fait pas lire tout le dossier', async () => {
	// La deuxième cartouche sur cinq. Le repli lisait les cinq avant de
	// seulement regarder laquelle il avait trouvée.
	const dossier = folder(ROMS);
	const wanted = ROMS[1];

	const bytes = await readRomByChecksum(dossier.handle, wanted.checksum, memoryIndex());

	assert.deepEqual(bytes && [...bytes], [...wanted.bytes]);
	assert.equal(dossier.reads(), 2, 'il ne doit avoir lu que jusqu\'à celle qu\'il cherchait');
});

test('une ROM à en-tête de copieur est rendue AVEC son en-tête', async () => {
	/*
	 * Le checksum se calcule sur la forme normalisée - c'est ce qui fait que deux
	 * dumps d'une même cartouche s'identifient pareil - mais les octets rendus
	 * sont les octets du fichier. Les deux chemins de lecture doivent s'accorder
	 * là-dessus : le repli rend désormais les octets que le hachage a lus, et
	 * s'il rendait la forme normalisée, un jeu lancé par balayage partirait vers
	 * le cœur amputé de 512 octets alors que le même jeu lancé par son nom
	 * mémorisé partirait entier. Aucune taille de ROM ronde ne peut le montrer,
	 * seule une taille à en-tête le peut.
	 */
	const headered = new Uint8Array(32 * 1024 + 512);
	for (let i = 0; i < headered.length; i++) headered[i] = (i * 13) & 0xff;
	const checksum = crc32(normaliseRom(headered));
	assert.notEqual(checksum, crc32(headered), 'sans quoi le test ne prouve rien');

	const dossier = folder([{ name: 'avec-entete.smc', bytes: headered }]);

	const parBalayage = await readRomByChecksum(dossier.handle, checksum, memoryIndex());
	const parNom = await readRomByChecksum(
		dossier.handle, checksum, memoryIndex({ [checksum]: 'avec-entete.smc' })
	);

	assert.deepEqual(parBalayage && [...parBalayage], [...headered]);
	assert.deepEqual(parNom && [...parNom], [...headered]);
});

test('un checksum que le dossier ne contient pas fait bien tout lire', async () => {
	// Le pendant du test précédent : s'arrêter tôt ne doit pas devenir
	// abandonner tôt. Sans celui-ci, une implémentation qui lit UN fichier et
	// rend null passerait le premier.
	const dossier = folder(ROMS);

	const bytes = await readRomByChecksum(dossier.handle, 'DEADBEEF', memoryIndex());

	assert.equal(bytes, null);
	assert.equal(dossier.reads(), ROMS.length);
});

test('le nom mémorisé évite le balayage entièrement', async () => {
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
	// Et ce que le balayage a traversé au passage n'est pas jeté : il a été lu
	// et haché, autant s'en souvenir.
	assert.equal(await index.filenameFor(ROMS[0].checksum), ROMS[0].name);
});

test('un balayage complet n\'écrit dans l\'index qu\'une fois', async () => {
	// Une écriture par cartouche, c'était une connexion IndexedDB ouverte et
	// refermée par cartouche.
	const dossier = folder(ROMS);
	const index = memoryIndex();

	const entries = await scanDirectory(dossier.handle, index);

	assert.equal(entries.length, ROMS.length);
	assert.equal(index.writes(), 1);
	assert.deepEqual(
		(await index.checksums()).sort(),
		ROMS.map(r => r.checksum).sort()
	);
});

/*
 * L'instrument, sans quoi le gain ne se vérifie que sur un banc.
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
		assert.equal(seen[0].filesRead, 3, 'la troisième cartouche, donc trois lectures');
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

test('un dossier sans ROM ne fait aucune écriture', async () => {
	const dossier = folder([{ name: 'notes.txt', bytes: new Uint8Array(4) }]);
	const index = memoryIndex();

	assert.deepEqual(await scanDirectory(dossier.handle, index), []);
	assert.equal(index.writes(), 0, 'rien à retenir ne doit pas ouvrir de transaction');
});
