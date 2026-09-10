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
const OFFER = { roomId: 'room-1', crc32: CRC, title: 'Umihara Kawase', from: 'friend-1' };

function harness(over: Partial<Parameters<typeof createSharing>[0]> = {}) {
	const emitted: Array<{ event: string; payload: unknown }> = [];
	const kept: Array<{ crc32: string; title: string }> = [];
	const sent: Array<{ to: string; bytes: Uint8Array }> = [];

	const asked: string[] = [];
	const deps = {
		inLibrary: async () => false,
		emit: (event: string, payload: unknown) => {
			emitted.push({ event, payload });
			return true;
		},
		resolve: async () => null,
		receive: async (crc32: string, roomId: string) => {
			asked.push(`${roomId}:${crc32}`);
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

	assert.equal(await sharing.offerReceived(OFFER), 'asked');

	assert.deepEqual(get(sharing.offered), OFFER);
});

test('accepter demande le dump nomme, puis le garde et l inscrit', async () => {
	const { sharing, kept, asked } = harness();
	await sharing.offerReceived(OFFER);

	await sharing.accept();

	// C est `receiveRom` qui emet la demande, et cette demande EST le
	// consentement que le relais exige avant de laisser passer le moindre
	// octet - voir `rom-relay.test.ts`. Ce qui compte ici est qu elle porte le
	// dump offert, et pas celui que le salon porterait.
	assert.deepEqual(asked, [`room-1:${CRC}`]);
	assert.deepEqual(kept, [{ crc32: CRC, title: 'Umihara Kawase' }]);
	assert.equal(get(sharing.offered), null, 'la question se referme');
});

test('refuser previent celui qui a offert, et ne garde rien', async () => {
	const { sharing, emitted, kept } = harness();
	await sharing.offerReceived(OFFER);

	sharing.decline();

	assert.deepEqual(emitted, [
		{ event: 'rom:offer-declined', payload: { roomId: 'room-1', to: 'friend-1' } }
	]);
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

test('une offre repond sur le salon qu elle nomme, pas sur celui que le client croit', async () => {
	const { sharing, emitted } = harness();
	await sharing.offerReceived({ ...OFFER, roomId: 'room-9' });

	sharing.decline();

	/*
	 * Le serveur vient de valider l appartenance au salon avant de relayer
	 * l offre. Repondre sur ce que le store local croit etre « mon salon »
	 * ajoute une facon de perdre le message et rien d autre : ce store ignore
	 * deliberement `room:updated`, et il peut donc etre en retard.
	 */
	assert.deepEqual(emitted, [
		{ event: 'rom:offer-declined', payload: { roomId: 'room-9', to: 'friend-1' } }
	]);
});

test('un jeu deja dans la bibliotheque est refuse, pas ignore', async () => {
	const { sharing, emitted } = harness({ inLibrary: async () => true });

	const decision = await sharing.offerReceived(OFFER);

	// Se taire laissait l offrant sur « En attente de… » pour toujours, sans
	// que personne puisse savoir pourquoi.
	assert.equal(decision, 'already-here');
	assert.equal(get(sharing.offered), null, 'la question ne se pose pas');
	assert.deepEqual(emitted, [
		{
			event: 'rom:offer-declined',
			payload: { roomId: 'room-1', to: 'friend-1', reason: 'already-here' }
		}
	]);
});

test('des octets lisibles sans fiche de bibliotheque ne suppriment pas la question', async () => {
	/*
	 * `resolveQuietly` repond « cet appareil peut-il ouvrir ce dump », pas
	 * « ce jeu est-il dans ta bibliotheque ». Le dossier de ROMs du joueur
	 * peut contenir le fichier sans que psnes en sache rien : il dira
	 * sincerement qu il n a pas le jeu, et supprimer la question lui refuse
	 * justement la fiche que le partage devait lui donner. Signale le
	 * 2026-09-10 : « mon ami n a pas ce jeu, du moins pas sur ce pc ».
	 */
	const { sharing, emitted } = harness({ resolve: async () => ROM, inLibrary: async () => false });

	const decision = await sharing.offerReceived(OFFER);

	assert.equal(decision, 'asked');
	assert.deepEqual(get(sharing.offered), OFFER);
	assert.deepEqual(emitted, []);
});

test('accepter un jeu dont les octets sont deja la saute le transfert', async () => {
	const { sharing, kept, asked } = harness({ resolve: async () => ROM });
	await sharing.offerReceived(OFFER);

	await sharing.accept();

	// Rien a transferer, seulement une fiche a inscrire - et quatre
	// megaoctets qui ne traversent pas le reseau pour rien.
	assert.deepEqual(asked, []);
	assert.deepEqual(kept, [{ crc32: CRC, title: 'Umihara Kawase' }]);
});

test('offrir n attend rien si l emission n est pas partie', () => {
	const { sharing } = harness({ emit: () => false });

	sharing.offer(CRC, 'Umihara Kawase');

	// Hors groupe ou sans socket, l emission est un non-evenement : afficher
	// « En attente de… » serait annoncer une question que personne n a recue.
	assert.equal(get(sharing.waiting), null);
});

test('un refus pour cause d injoignable arrete l attente', () => {
	const { sharing } = harness();
	sharing.offer(CRC, 'Umihara Kawase');

	sharing.declined();

	assert.equal(get(sharing.waiting), null);
});

test('la raison du refus est retenue, pour pouvoir etre dite', async () => {
	const { sharing } = harness();
	sharing.offer(CRC, 'Umihara Kawase');

	sharing.declined('already-here');

	/*
	 * « Il a deja ce jeu » est la seule information qui explique un ecran
	 * reste vide chez l ami, et la personne qui en a besoin est celle qui
	 * attend une reponse. Le 2026-09-10 elle existait, cote destinataire, et
	 * n arrivait nulle part : le relais la jetait et rien ne l affichait.
	 */
	assert.deepEqual(get(sharing.answer), { crc32: CRC, reason: 'already-here' });
});

test('un vrai non merci ne porte pas de raison', () => {
	const { sharing } = harness();
	sharing.offer(CRC, 'Umihara Kawase');

	sharing.declined();

	assert.deepEqual(get(sharing.answer), { crc32: CRC, reason: null });
});

test('offrir a nouveau efface la reponse precedente', () => {
	const { sharing } = harness();
	sharing.offer(CRC, 'Umihara Kawase');
	sharing.declined('already-here');

	sharing.offer(CRC, 'Umihara Kawase');

	// Sinon « il a deja ce jeu » resterait affiche sous un bouton qui attend.
	assert.equal(get(sharing.answer), null);
});
