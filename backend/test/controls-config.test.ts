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

test('migrating a legacy pad code frees the other button that held it too', () => {
	// The standard mapping already gives PadButton2 to Y. Leaving it there
	// too after A claims it would be a conflict the player never made, and
	// Save would refuse the config before they have touched anything.
	const config = normaliseControlsConfig({ ...V1, a: 'Gamepad0Button2' });
	assert.deepEqual(config.p1.pad.a, ['PadButton2'], 'the migrated code stays on the button it targeted');
	assert.deepEqual(config.p1.pad.y, [], 'Y gives up the code it shared with A');
});

test('a legacy gamepad axis code migrates to the pad table', () => {
	const config = normaliseControlsConfig({ ...V1, up: 'Gamepad0Axis1Minus' });
	assert.deepEqual(config.p1.pad.up, ['PadAxis1Minus']);
	assert.equal(config.p1.keys.up, '');
});

test('a v1 config with an unbound button is still read as v1', () => {
	// The detection gate must match the frontend's `looksLikeKeyConfig`:
	// twelve strings, '' allowed. Reading '' as "not a v1 config at all" threw
	// the whole row away and handed back the defaults, while the frontend kept
	// it - two normalisations that are supposed to agree.
	const config = normaliseControlsConfig({ ...V1, l: '' });
	assert.equal(config.p1.keys.l, '', 'the unbound button survives');
	assert.equal(config.p1.keys.a, 'KeyX', 'and the rest of the row with it');
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
