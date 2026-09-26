/**
 * Quand l'accueil devient le jeu en solo sans compte (#70), et ce que le
 * service worker a le droit de garder pour que cela marche hors-ligne.
 *
 * La décision de l'opérateur est double : un petit lien sur la page de
 * connexion, ET un basculement automatique - mais seulement quand le serveur
 * n'a JAMAIS répondu. Un joueur avec un compte dont le réseau hoquette ne doit
 * pas voir sa bibliothèque remplacée par un mode qui n'a ni ses jeux ni ses
 * sauvegardes.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import { homeMode, isOfflineMode, onlineControls, localPlayHref } from '../../frontend/src/lib/rooms/local-play.js';
import { linkState, noteServerSilent, serverSilent } from '../../frontend/src/lib/stores/connection.js';
import { localGames } from '../../frontend/src/lib/roms/local-games.js';
import {
	cacheableResponse,
	networkOnly,
	shellFallback
} from '../../frontend/src/lib/pwa/cache-policy.js';

const nobody = { user: null, loading: false, link: 'connected' as const, chosen: false };

test("tant que /auth/me n'a pas répondu, rien n'est tranché", () => {
	assert.deepEqual(homeMode({ ...nobody, loading: true, link: 'unreachable' }), { kind: 'waiting' });
});

test('personne, serveur joignable : la page de connexion', () => {
	assert.deepEqual(homeMode(nobody), { kind: 'signIn' });
});

test('le lien « Jouer sans compte » ouvre le mode local', () => {
	assert.deepEqual(homeMode({ ...nobody, chosen: true }), { kind: 'local', why: 'chosen' });
});

test('un serveur qui ne répond pas bascule tout seul, et seulement lui', () => {
	assert.deepEqual(homeMode({ ...nobody, link: 'unreachable' }), { kind: 'local', why: 'unreachable' });
	// Une connexion qui a existé n'est pas un serveur muet.
	assert.deepEqual(homeMode({ ...nobody, link: 'reconnecting' }), { kind: 'signIn' });
	assert.deepEqual(homeMode({ ...nobody, link: 'offline' }), { kind: 'signIn' });
});

test('un compte garde sa bibliothèque, même quand la socket est bloquée', () => {
	// `/auth/me` a répondu, donc le serveur aussi : l'`unreachable` vient de la
	// socket, et le bandeau du layout le dit déjà.
	const user = { isAnonymous: false };
	assert.deepEqual(homeMode({ ...nobody, user, link: 'unreachable', chosen: true }), { kind: 'account' });
});

test("en ligne, rien n'est éteint", () => {
	const on = onlineControls({ kind: 'account' });
	for (const [name, availability] of Object.entries(on)) assert.deepEqual(availability, { enabled: true }, name);
	assert.equal(isOfflineMode({ kind: 'account' }), false);
	assert.equal(isOfflineMode({ kind: 'signIn' }), false);
});

test('sans compte, ce qui appartient à un compte reste à sa place, éteint, faute de compte', () => {
	// #70 retirait ces contrôles ; ils restent maintenant, et disent pourquoi.
	for (const why of ['chosen', 'unreachable'] as const) {
		const mode = { kind: 'local' as const, why };
		assert.equal(isOfflineMode(mode), true);
		const off = onlineControls(mode);
		for (const name of ['friendsDrawer', 'friendActions', 'vr', 'gameDetails', 'rescan', 'accountSettings', 'configFile', 'savesArchive'] as const) {
			assert.deepEqual(off[name], { enabled: false, reason: 'needsAccount' }, name);
		}
	}
});

test('un compte hors-ligne garde son tiroir Amis, et tout ce qui parle au serveur y est éteint, faute de connexion', () => {
	const off = onlineControls({ kind: 'offline-account', account: { id: 'u1', pseudo: 'Sprite', discriminator: '0417' } });
	assert.deepEqual(off.friendsDrawer, { enabled: true }, 'la liste retenue se lit sans réseau');
	for (const name of ['friendActions', 'vr', 'gameDetails', 'rescan', 'accountSettings', 'configFile', 'savesArchive', 'logout'] as const) {
		assert.deepEqual(off[name], { enabled: false, reason: 'needsConnection' }, name);
	}
});

test("l'écran de jeu local est une route statique, donc précachée", () => {
	assert.equal(localPlayHref('B19ED489'), '/local?rom=B19ED489');
});

/* ------------------------------------------------------ le serveur muet */

test("un fetch qui lève, ou un proxy sans backend, c'est le serveur qui ne répond pas", () => {
	assert.equal(serverSilent({ threw: true }), true);
	for (const status of [502, 503, 504]) assert.equal(serverSilent({ status }), true, String(status));
	// Le serveur a parlé, même pour dire non.
	for (const status of [200, 401, 403, 404, 500]) assert.equal(serverSilent({ status }), false, String(status));
});

test("noteServerSilent ne recouvre pas ce qu'une socket a déjà dit", () => {
	linkState.set('reconnecting');
	noteServerSilent();
	assert.equal(get(linkState), 'reconnecting');

	linkState.set('connected');
	noteServerSilent();
	assert.equal(get(linkState), 'unreachable');
	linkState.set('connected');
});

/* ------------------------------------------------ la bibliothèque locale */

test('le titre est le nom de fichier, sans jaquette ni serveur', () => {
	const games = localGames({
		resolvable: ['AAA', 'BBB', 'CCC'],
		folder: [{ checksum: 'BBB', filename: 'Zelda.sfc' }],
		titles: new Map([['AAA', 'Axelay.smc']])
	});
	assert.deepEqual(
		games.map((g) => [g.title, g.filename]),
		[
			['Axelay', null],
			['CCC', null],
			['Zelda', 'Zelda.sfc']
		]
	);
});

test("un nom sans octets derrière n'est pas un jeu", () => {
	const games = localGames({
		resolvable: [],
		folder: [{ checksum: 'BBB', filename: 'Zelda.sfc' }],
		titles: new Map()
	});
	assert.deepEqual(games, []);
});

/* --------------------------------------------------- le service worker */

const ORIGIN = 'https://psnes.example';
const at = (path: string, origin = ORIGIN) => new URL(path, origin);

test("l'API, la session et la socket ne passent jamais par le cache", () => {
	// Une réponse /api servie depuis le cache après une déconnexion, c'est la
	// bibliothèque et les amis d'un autre joueur.
	for (const path of ['/api/games', '/api', '/auth/me', '/auth/google', '/socket.io/?EIO=4']) {
		assert.equal(networkOnly(at(path), ORIGIN), true, path);
	}
	for (const path of ['/', '/local', '/psnes-core/manifest.json', '/apiary.png', '/authors']) {
		assert.equal(networkOnly(at(path), ORIGIN), false, path);
	}
});

test('seule une réponse 200 lisible et non privée est gardée', () => {
	const response = (status: number, type: string, control: string | null = null) => ({
		status,
		type,
		headers: { get: (name: string) => (name === 'cache-control' ? control : null) }
	});
	assert.equal(cacheableResponse(response(200, 'basic')), true);
	assert.equal(cacheableResponse(response(200, 'cors', 'public, max-age=60')), true);
	assert.equal(cacheableResponse(response(404, 'basic')), false);
	assert.equal(cacheableResponse(response(0, 'opaque')), false);
	assert.equal(cacheableResponse(response(200, 'basic', 'private, max-age=0')), false);
	assert.equal(cacheableResponse(response(200, 'basic', 'no-store')), false);
});

test("hors-ligne, toute navigation reçoit la coquille de l'application", () => {
	assert.equal(shellFallback('navigate', at('/'), ORIGIN), true);
	assert.equal(shellFallback('navigate', at('/local?rom=AAA'), ORIGIN), true);
	assert.equal(shellFallback('navigate', at('/room/abc'), ORIGIN), true);
	// Pas une API déguisée en page, pas un autre site, pas une image.
	assert.equal(shellFallback('navigate', at('/auth/google'), ORIGIN), false);
	assert.equal(shellFallback('navigate', at('/', 'https://elsewhere.example'), ORIGIN), false);
	assert.equal(shellFallback('no-cors', at('/icon.svg'), ORIGIN), false);
});
