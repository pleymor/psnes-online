/**
 * Hors-ligne d'abord (#71) : ce qu'un joueur connecté voit sans réseau, et ce
 * que le service worker a le droit de garder pour le lui montrer.
 *
 * Deux choses peuvent être fausses ici sans que rien ne se voie en ligne :
 * une bibliothèque hors-ligne qui n'a plus ses titres ni ses jaquettes, et un
 * cache qui garde une réponse d'un compte et la sert au suivant.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
	coversToForget,
	offlineLibrary,
	snapshotOf
} from '../../frontend/src/lib/games/library-snapshot.js';
import {
	cacheableResponse,
	coverRequest,
	COVERS_CACHE,
	networkOnly
} from '../../frontend/src/lib/pwa/cache-policy.js';
import { homeMode, localPlayer } from '../../frontend/src/lib/rooms/local-play.js';
import {
	forgetAccount,
	readRememberedAccount,
	rememberAccount
} from '../../frontend/src/lib/stores/offline-account.js';
import { saveIdentity } from '../../frontend/src/lib/saves/identity.js';
import {
	forgetKnownFriends,
	knownFriendsOf,
	readKnownFriends,
	rememberFriends
} from '../../frontend/src/lib/stores/known-friends.js';

const ORIGIN = 'https://psnes.example';
const at = (path: string) => new URL(path, ORIGIN);

/* --------------------------------------------------- la bibliothèque vue */

const listed = [
	{ id: 'g1', title: 'Chrono Trigger', filename: 'ct.sfc', crc32: 'AAAAAAAA', coverUrl: '/covers/ct.webp', saves: [{ screenshot: 'data:image/png;base64,AAAA' }] },
	{ id: 'g2', title: 'Earthbound', filename: 'eb.sfc', crc32: 'BBBBBBBB', coverUrl: '/covers/eb.webp', saves: [] }
];

test('la copie garde les titres et les jaquettes, pas les vignettes des sauvegardes', () => {
	const snap = snapshotOf('u1', listed, 42);
	assert.equal(snap.userId, 'u1');
	assert.deepEqual(snap.games.map((g) => [g.title, g.coverUrl]), [
		['Chrono Trigger', '/covers/ct.webp'],
		['Earthbound', '/covers/eb.webp']
	]);
	assert.equal(JSON.stringify(snap).includes('data:image'), false, 'le poids est dans les vignettes');
});

test('hors-ligne, la bibliothèque est celle d\'en ligne, filtrée par ce que l\'appareil ouvre', () => {
	const shown = offlineLibrary({
		snapshot: snapshotOf('u1', listed, 1),
		resolvable: ['AAAAAAAA', 'CCCCCCCC'],
		local: [{ checksum: 'CCCCCCCC', title: 'Zelda', filename: 'Zelda.sfc' }]
	});
	assert.deepEqual(shown.map((g) => [g.title, g.coverUrl, g.seen]), [
		['Chrono Trigger', '/covers/ct.webp', true],
		['Zelda', null, false]
	]);
});

test("un jeu que le compte et l'appareil connaissent tous deux est une seule carte, celle du compte", () => {
	// Le cas du doublon : la même ROM, vue en ligne sous le compte et trouvée
	// dans le dossier. Une carte, avec le titre et la jaquette du serveur.
	const shown = offlineLibrary({
		snapshot: snapshotOf('u1', listed, 1),
		resolvable: ['AAAAAAAA', 'BBBBBBBB'],
		local: [
			{ checksum: 'AAAAAAAA', title: 'Chrono Trigger (USA)', filename: 'Chrono Trigger (USA).sfc' },
			{ checksum: 'BBBBBBBB', title: 'eb', filename: 'eb.sfc' }
		]
	});
	assert.deepEqual(shown.map((g) => [g.crc32, g.title, g.coverUrl]), [
		['AAAAAAAA', 'Chrono Trigger', '/covers/ct.webp'],
		['BBBBBBBB', 'Earthbound', '/covers/eb.webp']
	]);
});

test('la clé est le CRC32 quelle que soit sa casse, et une source qui le répète ne fait pas deux cartes', () => {
	const shown = offlineLibrary({
		snapshot: snapshotOf('u1', [{ ...listed[0], crc32: 'aaaaaaaa' }, { ...listed[0], id: 'g1-bis', coverUrl: null }], 1),
		resolvable: ['AAAAAAAA', 'cccccccc', 'CCCCCCCC'],
		local: [
			{ checksum: 'AAAAAAAA', title: 'ct', filename: 'ct.sfc' },
			{ checksum: 'CCCCCCCC', title: 'Zelda', filename: 'Zelda.sfc' },
			{ checksum: 'cccccccc', title: 'Zelda (copie)', filename: 'Zelda (copie).sfc' }
		]
	});
	assert.deepEqual(shown.map((g) => [g.crc32, g.title, g.coverUrl]), [
		['AAAAAAAA', 'Chrono Trigger', '/covers/ct.webp'],
		['CCCCCCCC', 'Zelda', null]
	]);
});

test("sans compte, la même liste : ce que l'appareil ouvre, une carte par ROM, triée par titre", () => {
	const shown = offlineLibrary({
		snapshot: null,
		resolvable: ['CCCCCCCC', 'AAAAAAAA'],
		local: [
			{ checksum: 'CCCCCCCC', title: 'Zelda', filename: 'Zelda.sfc' },
			{ checksum: 'AAAAAAAA', title: 'Chrono', filename: 'Chrono.sfc' }
		]
	});
	assert.deepEqual(shown.map((g) => g.title), ['Chrono', 'Zelda']);
});

/* ------------------------------------------------------ les amis retenus */

test('les amis retenus ne gardent que ce que le tiroir affiche, par compte, et partent à la déconnexion', () => {
	const storage = memoryStorage();
	rememberFriends(storage, 'u1', [
		{ friendshipId: 'f1', friendsSince: '2026-09-01', friend: { id: 'u2', pseudo: 'Bob', avatar: 'https://x/b.png', email: 'b@x' } as never },
		{ friendshipId: 42 as never, friend: { id: 'u3', pseudo: 'Nope' } }
	]);
	assert.deepEqual(readKnownFriends(storage, 'u1'), [
		{ friendshipId: 'f1', friendsSince: '2026-09-01', friend: { id: 'u2', pseudo: 'Bob', avatar: 'https://x/b.png' } }
	]);
	assert.deepEqual(readKnownFriends(storage, 'u9'), [], 'un autre compte ne lit pas ceux-là');
	forgetKnownFriends(storage, 'u1');
	assert.deepEqual(readKnownFriends(storage, 'u1'), []);
	storage.setItem('psnes.friends.u1', '{pas du json');
	assert.deepEqual(readKnownFriends(storage, 'u1'), []);
	assert.deepEqual(knownFriendsOf([]), []);
});

test('une jaquette que la liste suivante ne cite plus sort du cache : la fiche a changé', () => {
	const before = snapshotOf('u1', listed, 1);
	const after = snapshotOf('u1', [{ ...listed[0], coverUrl: '/covers/ct-v2.webp' }, listed[1]], 2);
	assert.deepEqual(coversToForget(before, after), ['/covers/ct.webp']);
	assert.deepEqual(coversToForget(null, after), []);
	assert.deepEqual(coversToForget(after, after), []);
});

/* ------------------------------------------------------ le service worker */

test('les jaquettes sont gardées, et seulement elles, sous /api', () => {
	assert.equal(coverRequest(at('/covers/abc.webp'), ORIGIN), true);
	assert.equal(coverRequest(at('/api/covers/meta-1'), ORIGIN), true);
	assert.equal(coverRequest(at('/api/games'), ORIGIN), false);
	assert.equal(coverRequest(at('/api/sync/AAAAAAAA/sram'), ORIGIN), false);
	assert.equal(coverRequest(new URL('https://elsewhere.example/covers/x.webp'), ORIGIN), false);
	assert.notEqual(COVERS_CACHE.includes('undefined'), true);
});

test('la bibliothèque, les sauvegardes et le profil ne passent jamais par le cache', () => {
	for (const path of ['/api/games', '/api/sync/AAAAAAAA/sram', '/api/user/me', '/api/friends', '/auth/me']) {
		assert.equal(networkOnly(at(path), ORIGIN), true, path);
	}
});

test('une réponse no-store - chaque réponse de la file la porte - n\'est jamais gardée', () => {
	const headers = (value: string) => ({ get: (name: string) => (name === 'cache-control' ? value : null) });
	assert.equal(cacheableResponse({ status: 200, type: 'basic', headers: headers('no-store') }), false);
	assert.equal(cacheableResponse({ status: 200, type: 'basic', headers: headers('public, immutable') }), true);
});

/* ------------------------------------------------------ le compte retenu */

function memoryStorage() {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k)
	};
}

test('le compte retenu ne garde que ce qu\'il faut pour dire « tu joues en tant que »', () => {
	const storage = memoryStorage();
	rememberAccount(storage, {
		id: 'u1', pseudo: 'Sprite', discriminator: '0417', isAnonymous: false, needsPseudo: false,
		avatar: 'https://x/y.png'
	} as never);
	assert.deepEqual(readRememberedAccount(storage), { id: 'u1', pseudo: 'Sprite', discriminator: '0417' });
	assert.equal([...storage.map.values()][0].includes('avatar'), false);
	forgetAccount(storage);
	assert.equal(readRememberedAccount(storage), null, 'oublié à la déconnexion');
});

test('ni un anonyme ni un compte sans pseudonyme ne sont retenus', () => {
	const storage = memoryStorage();
	rememberAccount(storage, { id: 'a', pseudo: 'x', discriminator: '1', isAnonymous: true });
	rememberAccount(storage, { id: 'b', pseudo: 'x', discriminator: '1', needsPseudo: true });
	assert.equal(readRememberedAccount(storage), null);
	storage.setItem('psnes.account', '{pas du json');
	assert.equal(readRememberedAccount(storage), null);
});

test('serveur muet et compte retenu : sa bibliothèque, pas le mode sans compte', () => {
	const account = { id: 'u1', pseudo: 'Sprite', discriminator: '0417' };
	assert.deepEqual(
		homeMode({ user: null, loading: false, link: 'unreachable', chosen: false, offline: account }),
		{ kind: 'offline-account', account }
	);
	assert.deepEqual(
		homeMode({ user: null, loading: false, link: 'unreachable', chosen: false, offline: null }),
		{ kind: 'local', why: 'unreachable' }
	);
	assert.equal(
		homeMode({ user: { isAnonymous: false }, loading: false, link: 'unreachable', chosen: false, offline: account }).kind,
		'account',
		'une session l\'emporte sur tout'
	);
});

test('les sauvegardes d\'une partie par /local vont à la session, sinon au compte retenu, sinon à personne', () => {
	assert.equal(localPlayer({ id: 'u1', isAnonymous: false }, null), 'u1');
	assert.equal(localPlayer(null, { id: 'u2' }), 'u2');
	assert.equal(localPlayer({ id: 'anon', isAnonymous: true }, { id: 'u2' }), null);
	assert.equal(localPlayer(null, null), null);
});

/* ----------------------------------------------- ce que la synchro a gardé */

test('une sauvegarde gardée par la synchro se lit comme telle, datée', () => {
	const labels = { state: 'Gardée à la synchro', sram: 'Sauvegarde de cartouche gardée' };
	const base = { id: 's', slotNumber: 3, screenshot: null, createdAt: '2026-09-25T10:00:00Z', updatedAt: '2026-09-25T10:00:00Z' };
	const sram = saveIdentity({ ...base, name: '__sram__', kind: 'sram' }, 'fr-FR', 'Rapide', labels);
	const state = saveIdentity({ ...base, name: '__kept__', kind: 'state' }, 'fr-FR', 'Rapide', labels);
	assert.equal(sram.primary, labels.sram);
	assert.equal(state.primary, labels.state);
	assert.ok(sram.secondary && state.secondary, 'la date distingue deux sauvegardes gardées');
});
