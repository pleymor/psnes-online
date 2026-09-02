/**
 * Le dossier de ROMs fait foi pour ce que cet appareil affiche.
 *
 * Deux moitiés, et la seconde est la dangereuse : les fichiers apparus
 * s'ajoutent, les fichiers disparus quittent l'index. L'index est ce qui
 * répond « ce jeu est ici » à la bibliothèque, donc une purge trop large
 * fait disparaître des jeux que le joueur possède vraiment.
 *
 * Rien ici ne touche IndexedDB ni l'API de fichiers : la décision est isolée
 * de la collecte, parce que c'est la décision qui peut se tromper sans que
 * personne le voie.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { syncFolder } from '../../frontend/src/lib/roms/folder-sync.js';
import type { LibraryEntry } from '../../frontend/src/lib/roms/local-library.js';

const entry = (checksum: string, filename = `${checksum}.sfc`): LibraryEntry =>
	({ checksum, filename, size: 512 });

/** Un double qui note ce qu'on lui demande, sans rien stocker de réel. */
function deps(folder: LibraryEntry[], index: string[]) {
	const registered: string[] = [];
	const forgotten: string[] = [];
	return {
		registered,
		forgotten,
		calls: {
			scan: async () => folder,
			register: async (checksum: string) => { registered.push(checksum); },
			indexed: async () => [...index, ...folder.map((e) => e.checksum)],
			forget: async (checksum: string) => { forgotten.push(checksum); }
		}
	};
}

test('un fichier apparu dans le dossier est enregistré', async () => {
	const d = deps([entry('aaaa1111')], []);
	const result = await syncFolder(d.calls);
	assert.deepEqual(d.registered, ['aaaa1111']);
	assert.equal(result.added, 1);
});

test('un checksum indexé absent du dossier est oublié', async () => {
	const d = deps([entry('aaaa1111')], ['bbbb2222']);
	const result = await syncFolder(d.calls);
	assert.deepEqual(d.forgotten, ['bbbb2222'], 'le fichier disparu quitte l index');
	assert.deepEqual(d.registered, ['aaaa1111'], 'et celui qui reste est réenregistré');
	assert.equal(result.removed, 1);
});

test('un dossier vide ne purge rien - un disque débranché n est pas un dossier vidé', async () => {
	const d = deps([], ['aaaa1111', 'bbbb2222']);
	const result = await syncFolder(d.calls);
	assert.deepEqual(d.forgotten, [], 'aucune purge sur un scan sans résultat');
	assert.equal(result.removed, 0);
	assert.equal(result.empty, true, 'et l appelant doit pouvoir le dire au joueur');
});

test('un jeu deja dans le compte n est pas reenregistre', async () => {
	const folder = [entry('aaaa1111'), entry('bbbb2222')];
	const registered: string[] = [];
	const result = await syncFolder({
		scan: async () => folder,
		register: async (checksum: string) => { registered.push(checksum); },
		indexed: async () => folder.map((e) => e.checksum),
		forget: async () => {},
		isKnown: (checksum) => checksum === 'aaaa1111'
	});
	assert.deepEqual(registered, ['bbbb2222'], 'seul le nouveau part au serveur');
	assert.equal(result.added, 1, 'et seul le nouveau est annonce comme ajoute');
	assert.equal(result.unchanged, 1);
});

test('un dossier ou rien n a change ne se prevaut d aucun ajout', async () => {
	const folder = [entry('aaaa1111'), entry('bbbb2222')];
	const result = await syncFolder({
		scan: async () => folder,
		register: async () => { throw new Error('ne devrait pas etre appele'); },
		indexed: async () => folder.map((e) => e.checksum),
		forget: async () => {},
		isKnown: () => true
	});
	assert.equal(result.added, 0);
	assert.equal(result.removed, 0);
	assert.equal(result.failed, 0);
	assert.equal(result.unchanged, 2);
});

test('un jeu connu reste dans le dossier, donc n est jamais purge', async () => {
	const forgotten: string[] = [];
	await syncFolder({
		scan: async () => [entry('aaaa1111')],
		register: async () => {},
		indexed: async () => ['aaaa1111'],
		forget: async (c: string) => { forgotten.push(c); },
		isKnown: () => true
	});
	assert.deepEqual(forgotten, []);
});

test('une ROM illisible n abandonne pas les trente-neuf autres', async () => {
	const folder = [entry('aaaa1111'), entry('bbbb2222'), entry('cccc3333')];
	const registered: string[] = [];
	const result = await syncFolder({
		scan: async () => folder,
		register: async (checksum: string) => {
			if (checksum === 'bbbb2222') throw new Error('illisible');
			registered.push(checksum);
		},
		indexed: async () => folder.map((e) => e.checksum),
		forget: async () => {}
	});
	assert.deepEqual(registered, ['aaaa1111', 'cccc3333']);
	assert.equal(result.added, 2);
	assert.equal(result.failed, 1);
});

test('la progression est annoncée fichier par fichier', async () => {
	const seen: string[] = [];
	const folder = [entry('aaaa1111'), entry('bbbb2222')];
	await syncFolder({
		scan: async () => folder,
		register: async () => {},
		indexed: async () => folder.map((e) => e.checksum),
		forget: async () => {},
		onProgress: (done, total, filename) => { seen.push(`${done}/${total} ${filename}`); }
	});
	assert.deepEqual(seen, ['1/2 aaaa1111.sfc', '2/2 bbbb2222.sfc']);
});

test('un échec de purge ne fait pas échouer la synchronisation', async () => {
	const result = await syncFolder({
		scan: async () => [entry('aaaa1111')],
		register: async () => {},
		indexed: async () => ['aaaa1111', 'bbbb2222'],
		forget: async () => { throw new Error('IndexedDB indisponible'); }
	});
	assert.equal(result.added, 1, 'l ajout compte quand même');
	assert.equal(result.removed, 0, 'et la purge ratée ne se prétend pas faite');
});
