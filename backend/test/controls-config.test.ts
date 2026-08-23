/**
 * Server-side normalisation and validation of the controls config.
 *
 * The column is opaque JSON: this module is the only thing standing between a
 * half-written config and a player. It must accept the v1 shape - a tab left
 * open on the old frontend still saves like that - without ever handing it
 * back unchanged.
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

test('the defaults have two players and two tables each', () => {
	const config = getDefaultControlsConfig();
	assert.equal(config.version, 2);
	assert.equal(config.p1.keys.a, 'KeyX');
	assert.equal(config.p2.keys.a, 'KeyN');
	assert.deepEqual(config.p1.pad.up, ['PadButton12', 'PadAxis1Minus']);
	assert.deepEqual(config.p2.pad.a, ['PadButton1']);
});

test('a v1 config is accepted on write and normalised on read', () => {
	assert.ok(isValidControlsConfig(V1), 'a stale tab must still be able to save');

	const config = normaliseControlsConfig(V1);
	assert.equal(config.version, 2);
	assert.deepEqual(config.p1.keys, V1);
	assert.equal(config.p2.keys.up, 'KeyI');
});

test('reading a plain v1 config fills p1.pad with the standard pad defaults', () => {
	const config = normaliseControlsConfig(V1);
	assert.deepEqual(config.p1.pad.up, ['PadButton12', 'PadAxis1Minus']);
	assert.deepEqual(config.p1.pad.down, ['PadButton13', 'PadAxis1Plus']);
	assert.deepEqual(config.p1.pad.a, ['PadButton1']);
	assert.deepEqual(config.p1.pad.select, ['PadButton8']);
});

test('a v2 config is accepted and passes through', () => {
	const v2 = normaliseControlsConfig(V1);
	assert.ok(isValidControlsConfig(v2));
	assert.deepEqual(normaliseControlsConfig(v2), v2, 'idempotent');
});

test('a legacy gamepad button code migrates to the pad table', () => {
	const config = normaliseControlsConfig({ ...V1, a: 'Gamepad0Button2' });
	assert.deepEqual(config.p1.pad.a, ['PadButton2']);
	assert.equal(config.p1.keys.a, '');
});

test('a legacy gamepad axis code migrates to the pad table', () => {
	const config = normaliseControlsConfig({ ...V1, up: 'Gamepad0Axis1Minus' });
	assert.deepEqual(config.p1.pad.up, ['PadAxis1Minus']);
	assert.equal(config.p1.keys.up, '');
});

test('junk is refused on write', () => {
	for (const junk of [null, undefined, 42, 'nope', [], {}, { version: 2 }, { ...V1, a: 3 }]) {
		assert.ok(!isValidControlsConfig(junk), `${JSON.stringify(junk)} must be refused`);
	}
});

test('an incomplete v2 config is refused on write but repaired on read', () => {
	const partial = { version: 2, p1: { keys: { a: 'KeyM' } } };
	assert.ok(!isValidControlsConfig(partial), 'a config with holes must not be written');
	assert.equal(normaliseControlsConfig(partial).p1.keys.up, 'ArrowUp', 'but it can still be read');
});

test('a deliberately unbound button is accepted on write and survives a read unchanged', () => {
	// '' and [] are the documented way to mark a button unbound - not a hole.
	// A player who unbinds L and R must be able to save that choice, and get
	// it back exactly as they left it.
	const config = getDefaultControlsConfig();
	config.p1.keys.l = '';
	config.p1.pad.l = [];

	assert.ok(isValidControlsConfig(config), 'an unbound button must not be treated as a hole');
	const read = normaliseControlsConfig(config);
	assert.equal(read.p1.keys.l, '');
	assert.deepEqual(read.p1.pad.l, []);
});
