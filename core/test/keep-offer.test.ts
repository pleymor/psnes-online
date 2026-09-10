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
 *
 * `register` en est un second, ajouté le 2026-09-10. Garder n'écrivait que les
 * octets sur l'appareil, sans ligne de bibliothèque - donc l'invité qui avait
 * répondu oui n'avait toujours aucune carte à cliquer, et ne pouvait pas
 * lancer seul le jeu qu'il venait d'accepter. Signalé exactement comme ça :
 * « j'ai cliqué sur garder le jeu et je n'ai toujours pas le jeu dans la
 * bibliothèque ».
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

/** Une bibliothèque qui note ce qu'on lui demande d'inscrire. */
function registrar() {
	const registered: Array<{ checksum: string; title: string }> = [];
	return {
		registered,
		register: async (checksum: string, title: string) => {
			registered.push({ checksum, title });
		}
	};
}

const deps = (
	keep: (bytes: Uint8Array) => Promise<string>,
	available = true,
	register: (checksum: string, title: string) => Promise<void> = async () => {}
) => ({
	keep,
	available: () => available,
	register
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

test('accepter inscrit aussi le jeu dans la bibliotheque', async () => {
	const store = spy();
	const library = registrar();
	const offer = createKeepOffer(deps(store.keep, true, library.register));
	offer.received(CRC, ROM, 'Donkey Kong Country');

	await offer.accept();

	// Garder les octets sans inscrire le jeu laisse l invite avec un fichier
	// qu il ne peut atteindre : aucune carte a cliquer, donc aucun lancement
	// possible en solo. Le titre vient du salon, faute de nom de fichier.
	assert.deepEqual(library.registered, [{ checksum: CRC, title: 'Donkey Kong Country' }]);
	assert.equal(store.kept.length, 1);
});

test('refuser n inscrit rien', () => {
	const library = registrar();
	const offer = createKeepOffer(deps(spy().keep, true, library.register));
	offer.received(CRC, ROM, 'Donkey Kong Country');

	offer.decline();

	assert.deepEqual(library.registered, []);
});

test('une inscription qui echoue ne fait pas echouer le fait de garder', async () => {
	const store = spy();
	const offer = createKeepOffer(
		deps(store.keep, true, async () => {
			throw new Error('hors ligne');
		})
	);
	offer.received(CRC, ROM, 'Donkey Kong Country');

	// La question est deja refermee quand l ecriture part - `keepQuietly` avale
	// ses echecs par choix, et une promesse rejetee ici remonterait en
	// unhandled rejection dans une page qui joue.
	await offer.accept();

	assert.equal(store.kept.length, 1, 'les octets sont sur l appareil quoi qu il arrive');
});
