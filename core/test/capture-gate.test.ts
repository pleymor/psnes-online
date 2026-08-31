/**
 * Capture gate tests.
 *
 * Binding the twelve pad buttons one after another turns a held input into a
 * hazard: the gamepad is polled twenty times a second, so a thumb resting on
 * a button for half a second would be written into every remaining slot
 * before the player noticed. Nothing downstream can detect that - the config
 * that comes out is perfectly well formed, just wrong - which is why the rule
 * lives in one place and is tested here rather than eyeballed in the browser.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { CaptureGate } from '../../frontend/src/lib/controls/capture-gate.js';

test('a held button is captured once, however long it is held', () => {
	const gate = new CaptureGate();

	assert.equal(gate.tick(['Gamepad0Button0']), 'Gamepad0Button0');
	for (let i = 0; i < 20; i++) {
		assert.equal(gate.tick(['Gamepad0Button0']), null);
	}
});

test('releasing and pressing again captures a second time', () => {
	const gate = new CaptureGate();

	assert.equal(gate.tick(['Gamepad0Button0']), 'Gamepad0Button0');
	assert.equal(gate.tick(['Gamepad0Button0']), null);
	assert.equal(gate.tick([]), null);
	assert.equal(gate.tick(['Gamepad0Button0']), 'Gamepad0Button0');
});

test('another button pressed while the first is held is still captured', () => {
	// Two thumbs on a pad is not a mistake to guard against: the player has
	// simply not let go of the button they bound to the previous slot yet.
	const gate = new CaptureGate();

	assert.equal(gate.tick(['Gamepad0Button0']), 'Gamepad0Button0');
	assert.equal(gate.tick(['Gamepad0Button0', 'Gamepad0Button1']), 'Gamepad0Button1');
	assert.equal(gate.tick(['Gamepad0Button0', 'Gamepad0Button1']), null);
});

test('an idle poll captures nothing', () => {
	const gate = new CaptureGate();

	assert.equal(gate.tick([]), null);
	assert.equal(gate.tick([]), null);
});

test('a stick held off centre is captured once, not once per poll', () => {
	const gate = new CaptureGate();

	assert.equal(gate.tick(['Gamepad0Axis1Minus']), 'Gamepad0Axis1Minus');
	assert.equal(gate.tick(['Gamepad0Axis1Minus']), null);
	assert.equal(gate.tick([]), null);
	assert.equal(gate.tick(['Gamepad0Axis1Plus']), 'Gamepad0Axis1Plus');
});

test('an auto-repeating keydown is ignored', () => {
	const gate = new CaptureGate();

	assert.equal(gate.keydown({ code: 'KeyX', repeat: false }), 'KeyX');
	assert.equal(gate.keydown({ code: 'KeyX', repeat: true }), null);
	assert.equal(gate.keydown({ code: 'KeyX', repeat: true }), null);
});

test('the same key may be bound to a later button too', () => {
	// Duplicates are allowed here and reported as a conflict once the whole
	// sequence is done, exactly as they are when binding one button at a time.
	const gate = new CaptureGate();

	assert.equal(gate.keydown({ code: 'KeyX', repeat: false }), 'KeyX');
	assert.equal(gate.keydown({ code: 'KeyX', repeat: false }), 'KeyX');
});

test('a key press is not blocked by a pad button someone is leaning on', () => {
	const gate = new CaptureGate();

	assert.equal(gate.tick(['Gamepad0Button0']), 'Gamepad0Button0');
	assert.equal(gate.keydown({ code: 'KeyX', repeat: false }), 'KeyX');
	// And the pad button is still held, so it must not be captured again.
	assert.equal(gate.tick(['Gamepad0Button0']), null);
});

test('reset forgets what was held, so a new sequence starts clean', () => {
	const gate = new CaptureGate();

	assert.equal(gate.tick(['Gamepad0Button0']), 'Gamepad0Button0');
	gate.reset();
	assert.equal(gate.tick(['Gamepad0Button0']), 'Gamepad0Button0');
});
