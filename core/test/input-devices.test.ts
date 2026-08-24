/**
 * Assignation des manettes aux joueurs.
 *
 * Deux joueurs sur une machine ne sont séparés que par ça. Une résolution qui
 * donne le même pad aux deux produit une manette qui pilote les deux ports -
 * exactement le symptôme qu'on vient corriger - et une résolution qui n'en
 * donne à personne produit un joueur muet sans message d'erreur.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	DEVICES_STORAGE_KEY,
	LEGACY_SOURCE_KEY,
	connectedPads,
	defaultAssignments,
	isPlayerActive,
	loadAssignments,
	padDisplayName,
	resolveSources,
	saveAssignments,
	withSingleAuto
} from '../../frontend/src/lib/znet/devices.js';

/** Un `localStorage` de test : la même API, en mémoire. */
function fakeStorage(seed: Record<string, string> = {}) {
	const map = new Map(Object.entries(seed));
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		clear: () => map.clear(),
		key: (i: number) => [...map.keys()][i] ?? null,
		get length() {
			return map.size;
		}
	} as Storage;
}

const PADS = [
	{ index: 0, id: '8BitDo SN30 (Vendor: 2dc8 Product: 6001)' },
	{ index: 1, id: 'Xbox Wireless Controller (Vendor: 045e Product: 02fd)' }
];

test('les défauts reproduisent le solo actuel', () => {
	const a = defaultAssignments();
	assert.deepEqual(a.p1, { keyboard: true, gamepad: 'auto' });
	assert.deepEqual(a.p2, { keyboard: false, gamepad: null });
	assert.ok(isPlayerActive(a.p1));
	assert.ok(!isPlayerActive(a.p2), 'le J2 est muet tant qu’il n’a pas de périphérique');
});

test('un joueur devient actif dès qu’il a un périphérique', () => {
	assert.ok(isPlayerActive({ keyboard: true, gamepad: null }));
	assert.ok(isPlayerActive({ keyboard: false, gamepad: 'auto' }));
	assert.ok(isPlayerActive({ keyboard: false, gamepad: { id: 'x', index: 0 } }));
	assert.ok(!isPlayerActive({ keyboard: false, gamepad: null }));
});

test("un joueur seul en 'auto' lit tous les pads, comme aujourd’hui", () => {
	const sources = resolveSources(defaultAssignments(), PADS);
	assert.deepEqual(sources.p1.pads, [0, 1]);
	assert.equal(sources.p1.keyboard, true);
	assert.deepEqual(sources.p2.pads, []);
	assert.equal(sources.p2.keyboard, false);
});

test("'auto' cesse de lire le pad revendiqué par l’autre joueur", () => {
	// Le symptôme d'origine : sans ça, la manette du J2 pilote aussi le J1.
	const sources = resolveSources(
		{
			p1: { keyboard: true, gamepad: 'auto' },
			p2: { keyboard: false, gamepad: { id: PADS[1].id, index: 1 } }
		},
		PADS
	);

	assert.deepEqual(sources.p1.pads, [0]);
	assert.deepEqual(sources.p2.pads, [1]);
});

test('un pad se retrouve par son id, même si son index a changé', () => {
	const moved = [{ index: 3, id: PADS[0].id }];
	const sources = resolveSources(
		{
			p1: { keyboard: true, gamepad: { id: PADS[0].id, index: 0 } },
			p2: { keyboard: false, gamepad: null }
		},
		moved
	);

	assert.deepEqual(sources.p1.pads, [3], 'l’id passe avant l’index');
});

test('l’index sert de repli quand l’id ne dit rien', () => {
	// Deux manettes identiques partagent le même id : il faut bien les séparer.
	const twins = [
		{ index: 0, id: 'Generic USB Gamepad' },
		{ index: 1, id: 'Generic USB Gamepad' }
	];
	const sources = resolveSources(
		{
			p1: { keyboard: false, gamepad: { id: 'Autre chose', index: 1 } },
			p2: { keyboard: false, gamepad: null }
		},
		twins
	);

	assert.deepEqual(sources.p1.pads, [1]);
});

test('un pad débranché ne donne rien du tout', () => {
	const sources = resolveSources(
		{
			p1: { keyboard: true, gamepad: { id: 'Parti', index: 7 } },
			p2: { keyboard: false, gamepad: null }
		},
		PADS
	);

	assert.deepEqual(sources.p1.pads, [], 'et surtout pas le premier pad venu');
});

test('deux revendications sur le même pad ne sont pas arbitrées', () => {
	// Les deux le lisent ; c'est la détection de conflits qui le dira à
	// l'écran. Trancher ici rendrait un joueur muet sans explication.
	const sources = resolveSources(
		{
			p1: { keyboard: false, gamepad: { id: PADS[0].id, index: 0 } },
			p2: { keyboard: false, gamepad: { id: PADS[0].id, index: 0 } }
		},
		PADS
	);

	assert.deepEqual(sources.p1.pads, [0]);
	assert.deepEqual(sources.p2.pads, [0]);
});

test('un aller-retour par le stockage conserve tout', () => {
	const storage = fakeStorage();
	const assignments = {
		p1: { keyboard: false, gamepad: { id: PADS[0].id, index: 0 } },
		p2: { keyboard: true, gamepad: { id: PADS[1].id, index: 1 } }
	};
	saveAssignments(storage, assignments);
	assert.deepEqual(loadAssignments(storage), assignments);
});

test('l’ancienne clé est migrée puis effacée', () => {
	for (const [legacy, expected] of [
		['auto', 'auto'],
		['off', null],
		['2', { id: '', index: 2 }]
	] as const) {
		const storage = fakeStorage({ [LEGACY_SOURCE_KEY]: legacy });
		const assignments = loadAssignments(storage);

		assert.deepEqual(assignments.p1.gamepad, expected, `${legacy} mal migré`);
		assert.equal(assignments.p1.keyboard, true);
		assert.deepEqual(assignments.p2, { keyboard: false, gamepad: null });
		assert.equal(storage.getItem(LEGACY_SOURCE_KEY), null, 'l’ancienne clé disparaît');
		assert.ok(storage.getItem(DEVICES_STORAGE_KEY), 'la nouvelle est écrite');
	}
});

test('une ancienne valeur illisible retombe sur les défauts', () => {
	const storage = fakeStorage({ [LEGACY_SOURCE_KEY]: 'n’importe quoi' });
	assert.deepEqual(loadAssignments(storage).p1.gamepad, 'auto');
});

test('un stockage vide ou corrompu donne les défauts', () => {
	assert.deepEqual(loadAssignments(fakeStorage()), defaultAssignments());
	assert.deepEqual(
		loadAssignments(fakeStorage({ [DEVICES_STORAGE_KEY]: '{ pas du json' })),
		defaultAssignments()
	);
	assert.deepEqual(
		loadAssignments(fakeStorage({ [DEVICES_STORAGE_KEY]: '{"p1":{"gamepad":"n\'importe"}}' })),
		defaultAssignments()
	);
});

test('le nom affiché d’un pad perd son identifiant USB', () => {
	assert.equal(padDisplayName(PADS[0].id), '8BitDo SN30');
	assert.equal(padDisplayName('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'Xbox 360 Controller');
	assert.equal(padDisplayName('  '), '');
});

test('énumérer les pads survit à l’absence d’API', () => {
	assert.deepEqual(connectedPads({} as Navigator), []);
	assert.deepEqual(
		connectedPads({
			getGamepads: () => [
				{ index: 0, id: 'Un pad', connected: true },
				null,
				{ index: 2, id: 'Virtual Gamepad 1', connected: true },
				{ index: 3, id: 'Débranché', connected: false }
			]
		} as unknown as Navigator),
		[{ index: 0, id: 'Un pad' }],
		'les pads virtuels et déconnectés ne comptent pas'
	);
});

test("withSingleAuto démote le J2 quand les deux sont 'auto'", () => {
	const demoted = withSingleAuto({
		p1: { keyboard: true, gamepad: 'auto' },
		p2: { keyboard: false, gamepad: 'auto' }
	});
	assert.deepEqual(demoted, {
		p1: { keyboard: true, gamepad: 'auto' },
		p2: { keyboard: false, gamepad: null }
	});

	const untouched = {
		p1: { keyboard: true, gamepad: 'auto' as const },
		p2: { keyboard: false, gamepad: null }
	};
	assert.deepEqual(withSingleAuto(untouched), untouched, 'un seul auto ne change rien');
});

test("un stockage bricolé avec les deux joueurs en 'auto' est corrigé au chargement", () => {
	const storage = fakeStorage({
		[DEVICES_STORAGE_KEY]: JSON.stringify({
			p1: { keyboard: true, gamepad: 'auto' },
			p2: { keyboard: false, gamepad: 'auto' }
		})
	});

	assert.deepEqual(loadAssignments(storage).p2.gamepad, null);
});

test("deux 'auto' en mémoire ne redonnent pas le bug d'origine : le J1 prend tout, le J2 rien", () => {
	// C'est le test de non-régression du symptôme original : sans la garde
	// dans resolveSources, `claimed.p1 = claimed.p2 = []` et les deux joueurs
	// recevraient tous les pads.
	const sources = resolveSources(
		{
			p1: { keyboard: true, gamepad: 'auto' },
			p2: { keyboard: false, gamepad: 'auto' }
		},
		PADS
	);

	assert.deepEqual(sources.p1.pads, [0, 1]);
	assert.deepEqual(sources.p2.pads, []);
});

test('un champ gamepad corrompu ne fait pas perdre le choix clavier valide du joueur', () => {
	const storage = fakeStorage({
		[DEVICES_STORAGE_KEY]: JSON.stringify({
			p1: { keyboard: false, gamepad: 'garbage' }
		})
	});

	const assignments = loadAssignments(storage);
	assert.equal(assignments.p1.keyboard, false, 'le clavier désactivé volontairement doit survivre');
	assert.equal(assignments.p1.gamepad, 'auto', 'seul le champ invalide retombe sur le défaut');
});
