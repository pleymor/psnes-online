/**
 * Normalisation de la config de contrôles.
 *
 * Ce module est la seule porte par laquelle une config entre dans le front :
 * une forme v1 venue de la base, une v2 déjà normalisée, ou n'importe quoi.
 * Une normalisation qui laisse passer un trou produit un joueur dont un
 * bouton ne répond pas, et rien en amont ne le rattrape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	BUTTONS,
	DEFAULT_P1_KEYS,
	DEFAULT_P2_KEYS,
	STANDARD_PAD,
	defaultControlsConfig,
	isPadCode,
	legacyToPadCode,
	normaliseControlsConfig,
	parsePadCode
} from '../../frontend/src/lib/controls/binding.js';

const V1 = {
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA',
	l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight'
};

test('les douze boutons SNES, et rien de plus', () => {
	assert.equal(BUTTONS.length, 12);
	assert.deepEqual([...BUTTONS].sort(), [
		'a', 'b', 'down', 'l', 'left', 'r', 'right', 'select', 'start', 'up', 'x', 'y'
	]);
});

test('les défauts des deux joueurs ne se croisent jamais', () => {
	const p1 = new Set(Object.values(DEFAULT_P1_KEYS));
	for (const code of Object.values(DEFAULT_P2_KEYS)) {
		assert.ok(!p1.has(code), `${code} est dans les deux jeux de défauts`);
	}
});

test('le mappage standard couvre la croix par les boutons ET par le stick', () => {
	// La table en dur qu'il remplace lisait les deux. Ne garder qu'un des deux
	// couperait le stick gauche sur toute manette XInput.
	assert.deepEqual(STANDARD_PAD.up, ['PadButton12', 'PadAxis1Minus']);
	assert.deepEqual(STANDARD_PAD.down, ['PadButton13', 'PadAxis1Plus']);
	assert.deepEqual(STANDARD_PAD.left, ['PadButton14', 'PadAxis0Minus']);
	assert.deepEqual(STANDARD_PAD.right, ['PadButton15', 'PadAxis0Plus']);
	assert.deepEqual(STANDARD_PAD.a, ['PadButton1']);
	assert.deepEqual(STANDARD_PAD.select, ['PadButton8']);
});

test('reconnaître et découper un code manette', () => {
	assert.ok(isPadCode('PadButton12'));
	assert.ok(isPadCode('PadAxis0Minus'));
	assert.ok(!isPadCode('KeyX'));
	assert.ok(!isPadCode('Gamepad0Button2'), 'un code legacy n’est pas un code manette');

	assert.deepEqual(parsePadCode('PadButton12'), { kind: 'button', index: 12 });
	assert.deepEqual(parsePadCode('PadAxis1Plus'), { kind: 'axis', index: 1, dir: 'plus' });
	assert.equal(parsePadCode('KeyX'), null);
});

test('les codes legacy perdent leur index de périphérique', () => {
	assert.equal(legacyToPadCode('Gamepad0Button2'), 'PadButton2');
	assert.equal(legacyToPadCode('Gamepad1Button11'), 'PadButton11');
	assert.equal(legacyToPadCode('Gamepad0Axis1Plus'), 'PadAxis1Plus');
	assert.equal(legacyToPadCode('KeyX'), null);
});

test('une KeyConfig nue devient un v2 complet', () => {
	const config = normaliseControlsConfig(V1);

	assert.equal(config.version, 2);
	assert.deepEqual(config.p1.keys, V1, 'les touches du J1 sont reprises telles quelles');
	assert.deepEqual(config.p1.pad, STANDARD_PAD, 'le J1 hérite du mappage standard');
	assert.deepEqual(config.p2.keys, DEFAULT_P2_KEYS, 'le J2 apparaît avec ses défauts');
	assert.deepEqual(config.p2.pad, STANDARD_PAD);
});

test('un code manette legacy migre vers la table manette et libère le clavier', () => {
	const config = normaliseControlsConfig({ ...V1, a: 'Gamepad0Button2' });

	assert.deepEqual(config.p1.pad.a, ['PadButton2'], 'la liaison passe côté manette');
	assert.equal(config.p1.keys.a, '', 'et l’emplacement clavier devient non lié');
	assert.deepEqual(config.p1.pad.b, STANDARD_PAD.b, 'les autres emplacements ne bougent pas');
});

test('un v2 traverse sans être réécrit, emplacements vidés compris', () => {
	const input = {
		version: 2,
		p1: { keys: { ...V1, l: '' }, pad: { ...STANDARD_PAD, l: [] } },
		p2: { keys: DEFAULT_P2_KEYS, pad: { ...STANDARD_PAD, a: ['PadButton7'] } }
	};
	const config = normaliseControlsConfig(input);

	assert.equal(config.p1.keys.l, '', 'un emplacement clavier vidé reste vide');
	assert.deepEqual(config.p1.pad.l, [], 'une liste vidée reste vide');
	assert.deepEqual(config.p2.pad.a, ['PadButton7'], 'une liaison choisie est conservée');
});

test('la normalisation est idempotente', () => {
	const once = normaliseControlsConfig(V1);
	assert.deepEqual(normaliseControlsConfig(once), once);
});

test('les clés manquantes sont complétées, la saleté est remplacée', () => {
	const partial = normaliseControlsConfig({ version: 2, p1: { keys: { a: 'KeyM' } } });
	assert.equal(partial.p1.keys.a, 'KeyM');
	assert.equal(partial.p1.keys.up, DEFAULT_P1_KEYS.up, 'le reste vient des défauts');
	assert.deepEqual(partial.p1.pad, STANDARD_PAD, 'une table pad absente vaut le standard');

	for (const junk of [null, undefined, 42, 'nope', [], {}, { version: 9 }]) {
		assert.deepEqual(
			normaliseControlsConfig(junk),
			defaultControlsConfig(),
			`${JSON.stringify(junk)} doit retomber sur les défauts`
		);
	}
});

test('les codes non-manette sont écartés de la table manette', () => {
	const config = normaliseControlsConfig({
		version: 2,
		p1: { keys: V1, pad: { ...STANDARD_PAD, a: ['KeyX', 'PadButton1', 7] } }
	});
	assert.deepEqual(config.p1.pad.a, ['PadButton1']);
});
