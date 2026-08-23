/**
 * Normalisation et validation de la config de contrôles, côté serveur.
 *
 * La colonne est un JSON opaque : ce module est la seule chose qui empêche une
 * config à moitié écrite d'atteindre un joueur. Il doit accepter la forme v1 -
 * un onglet resté ouvert sur l'ancien front sauvegarde encore comme ça - sans
 * jamais la rendre telle quelle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getDefaultControlsConfig,
	isValidControlsConfig,
	normaliseControlsConfig
} from '../src/utils/key-config.js';

const V1 = {
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA',
	l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight'
};

test('les défauts ont deux joueurs et deux tables chacun', () => {
	const config = getDefaultControlsConfig();
	assert.equal(config.version, 2);
	assert.equal(config.p1.keys.a, 'KeyX');
	assert.equal(config.p2.keys.a, 'KeyN');
	assert.deepEqual(config.p1.pad.up, ['PadButton12', 'PadAxis1Minus']);
	assert.deepEqual(config.p2.pad.a, ['PadButton1']);
});

test('une v1 est acceptée en écriture et normalisée en lecture', () => {
	assert.ok(isValidControlsConfig(V1), 'un onglet périmé doit pouvoir sauvegarder');

	const config = normaliseControlsConfig(V1);
	assert.equal(config.version, 2);
	assert.deepEqual(config.p1.keys, V1);
	assert.equal(config.p2.keys.up, 'KeyI');
});

test('une v2 est acceptée et traverse', () => {
	const v2 = normaliseControlsConfig(V1);
	assert.ok(isValidControlsConfig(v2));
	assert.deepEqual(normaliseControlsConfig(v2), v2, 'idempotente');
});

test('un code manette legacy migre côté manette', () => {
	const config = normaliseControlsConfig({ ...V1, a: 'Gamepad0Button2' });
	assert.deepEqual(config.p1.pad.a, ['PadButton2']);
	assert.equal(config.p1.keys.a, '');
});

test('la saleté est refusée en écriture', () => {
	for (const junk of [null, undefined, 42, 'nope', [], {}, { version: 2 }, { ...V1, a: 3 }]) {
		assert.ok(!isValidControlsConfig(junk), `${JSON.stringify(junk)} doit être refusé`);
	}
});

test('une v2 incomplète est refusée en écriture mais réparée en lecture', () => {
	const partial = { version: 2, p1: { keys: { a: 'KeyM' } } };
	assert.ok(!isValidControlsConfig(partial), 'on n’écrit pas une config à trous');
	assert.equal(normaliseControlsConfig(partial).p1.keys.up, 'ArrowUp', 'mais on sait la lire');
});
