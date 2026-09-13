/**
 * Comment le coeur est trouve, et ce qui arrive quand on en trouve un mauvais.
 *
 * Le 2026-09-13, une partie a cesse de demarrer en production avec
 * « offset is out of bounds » sur `HEAPU8.set`. La cause n'etait pas dans le
 * code : le navigateur tenait en cache un `psnes_core.wasm` d'une build
 * anterieure, apparie a la glu neuve. Les lettres d'export changent d'une
 * build a l'autre, donc `wasmExports["w"]` ne designait plus la memoire, et
 * toutes les vues JS naissaient a longueur nulle - pendant que `_malloc`
 * continuait de rendre des pointeurs valides, puisqu'il s'execute dans le wasm
 * sans passer par elles.
 *
 * Deux choses sont testees ici, et elles repondent a deux questions
 * differentes : comment rendre ce desappariement IMPOSSIBLE (des noms qui
 * changent avec le contenu), et comment le rendre LISIBLE s'il survient quand
 * meme (echouer a la creation, en nommant la cause, plutot que deux cents
 * lignes plus loin sur une erreur de bornes).
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { coreUrls, LEGACY_MODULE_URL, LEGACY_WASM_URL } from '../../frontend/src/lib/znet/loader.js';
import { PsnesCore, type PsnesCoreModule } from '../../frontend/src/lib/znet/core.js';

/* ------------------------------------------------------- le manifeste */

test('un manifeste valide donne des URL portant le hachage', () => {
	const urls = coreUrls({ module: 'psnes_core.a1b2c3d4.mjs', wasm: 'psnes_core.e5f6a7b8.wasm' });

	assert.equal(urls.moduleUrl, '/psnes-core/psnes_core.a1b2c3d4.mjs');
	assert.equal(urls.wasmUrl, '/psnes-core/psnes_core.e5f6a7b8.wasm');
});

test('sans manifeste, on retombe sur les noms fixes', () => {
	// Un depot ou `core/build.sh` n'a jamais tourne n'a ni manifeste ni
	// artefacts ; le chargement echouera, mais sur un 404 qui se lit, pas sur
	// une exception dans la resolution.
	const urls = coreUrls(null);

	assert.equal(urls.moduleUrl, LEGACY_MODULE_URL);
	assert.equal(urls.wasmUrl, LEGACY_WASM_URL);
});

test('un manifeste abime retombe aussi sur les noms fixes', () => {
	for (const abime of [{}, { module: 'x.mjs' }, { wasm: 'x.wasm' }, { module: 1, wasm: 2 }]) {
		const urls = coreUrls(abime as never);
		assert.equal(urls.moduleUrl, LEGACY_MODULE_URL, JSON.stringify(abime));
	}
});

test('un manifeste ne peut pas faire sortir du dossier du coeur', () => {
	// Le manifeste vient du reseau. Un nom qui remonte d'un cran ferait charger
	// n'importe quoi comme s'il s'agissait du coeur.
	const urls = coreUrls({ module: '../../evil.mjs', wasm: '/ailleurs/x.wasm' });

	assert.equal(urls.moduleUrl, LEGACY_MODULE_URL);
	assert.equal(urls.wasmUrl, LEGACY_WASM_URL);
});

/* ------------------------------------------------- le garde-fou du coeur */

/** Un module minimal, dont seul le tas nous interesse ici. */
function fakeModule(heapLength: number): PsnesCoreModule {
	return {
		HEAPU8: new Uint8Array(heapLength),
		_pn_init: () => 1
	} as unknown as PsnesCoreModule;
}

test('un coeur dont le tas est vide est refuse a la creation', async () => {
	// Exactement l'etat qu'un wasm perime produit : le module s'instancie,
	// `_pn_init` repond, et toutes les vues sont vides.
	await assert.rejects(
		() => PsnesCore.create(async () => fakeModule(0)),
		(err: Error) => {
			assert.match(err.message, /m[ée]moire/i, `message obtenu : ${err.message}`);
			return true;
		}
	);
});

test('un coeur dont le tas est reel passe', async () => {
	const core = await PsnesCore.create(async () => fakeModule(1024));

	assert.equal(core.raw.HEAPU8.length, 1024);
});
