/**
 * Envoyer un de ses jeux a l ami de son groupe, depuis la bibliotheque.
 *
 * Le transfert n existait qu a l interieur d une partie : un invite sans le
 * fichier le recevait au lancement. Partager etait donc un effet de bord, et
 * il arrivait au seul moment ou deux joueurs attendaient l un sur l autre -
 * d ou la serie de rustines du 2026-09-10. Le proprietaire a demande de
 * decorreler les deux, et c est la regle du geste decorrele qui est ici.
 *
 * Un groupe EST un salon, donc rien ne change cote autorisation. Ce module ne
 * porte que la conversation : qui offre, qui accepte, ce qu accepter veut
 * dire. Les octets, la socket et IndexedDB sont des seams, pour la raison que
 * `keep-offer.ts` donne pour les siens.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';

import { createSharing } from '../../frontend/src/lib/roms/sharing.js';

const ROM = new Uint8Array([1, 2, 3]);
const CRC = 'AAAA1111';
const OFFER = { crc32: CRC, title: 'Umihara Kawase', from: 'friend-1' };

function harness(over: Partial<Parameters<typeof createSharing>[0]> = {}) {
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const kept: Array<{ crc32: string; title: string }> = [];
	const sent: Array<{ to: string; bytes: Uint8Array }> = [];

	const asked: string[] = [];
	const deps = {
		emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
		resolve: async () => null,
		receive: async (crc32: string) => {
			asked.push(crc32);
			return ROM;
		},
		keep: async (_bytes: Uint8Array, crc32: string, title: string) => {
			kept.push({ crc32, title });
		},
		send: async (to: string, bytes: Uint8Array) => {
			sent.push({ to, bytes });
		},
		...over
	};

	return { sharing: createSharing(deps), emitted, kept, sent, asked };
}

test('rien n est propose tant qu aucune offre n arrive', () => {
	const { sharing } = harness();
	assert.equal(get(sharing.offered), null);
});

test('une offre recue nomme le jeu et l ami', async () => {
	const { sharing } = harness();

	await sharing.offerReceived(OFFER);

	assert.deepEqual(get(sharing.offered), OFFER);
});

test('une offre pour un jeu deja sur cet appareil n est pas posee', async () => {
	const { sharing, emitted } = harness({ resolve: async () => ROM });

	await sharing.offerReceived(OFFER);

	// Celui qui offre ne sait pas ce que l autre possede. Poser la question
	// pour un jeu deja la ferait repondre « oui » puis ne rien changer.
	assert.equal(get(sharing.offered), null);
	assert.deepEqual(emitted, []);
});

test('accepter demande le dump nomme, puis le garde et l inscrit', async () => {
	const { sharing, kept, asked } = harness();
	await sharing.offerReceived(OFFER);

	await sharing.accept();

	// C est `receiveRom` qui emet la demande, et cette demande EST le
	// consentement que le relais exige avant de laisser passer le moindre
	// octet - voir `rom-relay.test.ts`. Ce qui compte ici est qu elle porte le
	// dump offert, et pas celui que le salon porterait.
	assert.deepEqual(asked, [CRC]);
	assert.deepEqual(kept, [{ crc32: CRC, title: 'Umihara Kawase' }]);
	assert.equal(get(sharing.offered), null, 'la question se referme');
});

test('refuser previent celui qui a offert, et ne garde rien', async () => {
	const { sharing, emitted, kept } = harness();
	await sharing.offerReceived(OFFER);

	sharing.decline();

	assert.deepEqual(emitted, [{ event: 'rom:offer-declined', payload: { to: 'friend-1' } }]);
	assert.deepEqual(kept, []);
	assert.equal(get(sharing.offered), null);
});

test('un transfert qui echoue referme la question sans rien garder', async () => {
	const { sharing, kept } = harness({
		receive: async () => {
			throw new Error('le pair a disparu');
		}
	});
	await sharing.offerReceived(OFFER);

	await sharing.accept();

	// Refermer plutot que laisser une carte qui ne mene nulle part : l ami
	// peut reproposer, et rien n a ete garde a moitie.
	assert.deepEqual(kept, []);
	assert.equal(get(sharing.offered), null);
});

test('offrir annonce le dump et attend une reponse', () => {
	const { sharing, emitted } = harness();

	sharing.offer(CRC, 'Umihara Kawase');

	assert.deepEqual(emitted, [
		{ event: 'rom:offer', payload: { crc32: CRC, title: 'Umihara Kawase' } }
	]);
	assert.equal(get(sharing.waiting), CRC);
});

test('un refus recu arrete l attente', () => {
	const { sharing } = harness();
	sharing.offer(CRC, 'Umihara Kawase');

	sharing.declined();

	// Sinon le bouton attendrait pour toujours une reponse deja donnee.
	assert.equal(get(sharing.waiting), null);
});

test('repondre a une demande envoie les octets que cet appareil a', async () => {
	const { sharing, sent } = harness({ resolve: async () => ROM });
	sharing.offer(CRC, 'Umihara Kawase');

	await sharing.requested('friend-1', CRC);

	assert.deepEqual(sent, [{ to: 'friend-1', bytes: ROM }]);
	assert.equal(get(sharing.waiting), null, 'l attente finit quand l envoi finit');
});

test('une demande pour un dump que cet appareil n a pas recoit une reponse, pas un silence', async () => {
	const { sharing, emitted, sent } = harness({ resolve: async () => null });

	await sharing.requested('friend-1', 'BBBB2222');

	// Sans ca le demandeur attend le delai d expiration de `receiveRom`
	// devant un ecran qui ne dit rien.
	assert.deepEqual(sent, []);
	assert.deepEqual(emitted, [
		{ event: 'rom:unavailable', payload: { to: 'friend-1', reason: 'no-copy' } }
	]);
});
