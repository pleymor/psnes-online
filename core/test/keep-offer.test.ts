/**
 * La question « garder ce jeu ? » posée à l'invité, hors casque.
 *
 * La règle vient de `kept-files.ts` : ce qu'un hôte envoie n'entre jamais dans
 * le magasin de lui-même, et la décision du 2026-09-08 est de DEMANDER. Elle
 * n'était tenue que par `VrShell.svelte` ; les rooms plates recevaient la ROM
 * et la mettaient en cache, donc les octets mouraient avec l'onglet et
 * l'invité redemandait le même transfert à chaque partie.
 *
 * Ce qui est testé ici est le contrat, pas IndexedDB : `keep` est un seam, sur
 * le modèle de `readAndKeep` dans `provider.ts`.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';

import { createKeepOffer } from '../../frontend/src/lib/roms/keep-offer.js';

const ROM = new Uint8Array([1, 2, 3]);
const CRC = 'aaaa1111';

/** Un magasin qui note ce qu'on lui demande de garder. */
function spy() {
	const kept: Uint8Array[] = [];
	return {
		kept,
		keep: async (bytes: Uint8Array) => {
			kept.push(bytes);
			return CRC;
		}
	};
}

const deps = (keep: (bytes: Uint8Array) => Promise<string>, available = true) => ({
	keep,
	available: () => available
});

test('rien n est demandé tant qu aucun transfert n a eu lieu', () => {
	const offer = createKeepOffer(deps(spy().keep));
	assert.equal(get(offer.asked), null);
});

test('une ROM reçue pose la question, et la question nomme son checksum', () => {
	const offer = createKeepOffer(deps(spy().keep));
	offer.received(CRC, ROM);
	assert.equal(get(offer.asked), CRC);
});

test('accepter garde exactement les octets reçus, et referme la question', async () => {
	const store = spy();
	const offer = createKeepOffer(deps(store.keep));

	offer.received(CRC, ROM);
	await offer.accept();

	assert.deepEqual(store.kept, [ROM]);
	assert.equal(get(offer.asked), null);
});

test('refuser ne garde rien - c est tout l intérêt de poser la question', () => {
	const store = spy();
	const offer = createKeepOffer(deps(store.keep));

	offer.received(CRC, ROM);
	offer.decline();

	assert.deepEqual(store.kept, []);
	assert.equal(get(offer.asked), null);
});

test('un navigateur qui ne peut rien garder ne le propose pas', () => {
	const store = spy();
	const offer = createKeepOffer(deps(store.keep, false));

	offer.received(CRC, ROM);

	assert.equal(get(offer.asked), null, 'promettre de garder sans magasin serait un mensonge');
});

test('une réponse déjà donnée ne se redemande pas', () => {
	// Une reconnexion retransfère la ROM. Reposer la question à chaque fois
	// serait du harcèlement pour un refus déjà exprimé.
	const offer = createKeepOffer(deps(spy().keep));

	offer.received(CRC, ROM);
	offer.decline();
	offer.received(CRC, ROM);

	assert.equal(get(offer.asked), null);
});

test('accepter sans question en cours ne fait rien, plutôt que de lever', async () => {
	const store = spy();
	const offer = createKeepOffer(deps(store.keep));

	await offer.accept();

	assert.deepEqual(store.kept, []);
});

test('une seconde ROM, dans une autre room, se demande pour elle-même', () => {
	const offer = createKeepOffer(deps(spy().keep));

	offer.received(CRC, ROM);
	offer.decline();
	offer.received('bbbb2222', new Uint8Array([4, 5, 6]));

	assert.equal(get(offer.asked), 'bbbb2222');
});
