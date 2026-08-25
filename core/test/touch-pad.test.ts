/**
 * The on-screen pad, on a phone or a tablet.
 *
 * Everything here is the arithmetic between a thumb and a libretro mask. The
 * component that draws the pad is deliberately logic-free, so this is the only
 * place where a wrong sector, a missing dead zone or a button that never gets
 * its release can be caught - and a stuck button on a touch screen is worse
 * than on a keyboard, since there is no second device to press the key again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TouchPad, shouldShowTouchPad, stickMask, touchPadWanted } from '../../frontend/src/lib/controls/touch.js';
import { InputCollector } from '../../frontend/src/lib/znet/input.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';
import { STANDARD_PAD } from '../../frontend/src/lib/controls/binding.js';

test('a thumb resting near the centre of the stick is not a direction', () => {
	assert.equal(stickMask(0, 0), 0);
	assert.equal(stickMask(0.1, -0.1), 0);
});

test('pushing the stick right is right, and nothing else', () => {
	assert.equal(stickMask(1, 0), PAD.RIGHT);
});

test('screen coordinates: up is a negative y', () => {
	assert.equal(stickMask(0, -1), PAD.UP);
	assert.equal(stickMask(0, 1), PAD.DOWN);
});

test('a corner gives both directions, which is how a diagonal is played', () => {
	assert.equal(stickMask(0.6, -0.6), PAD.UP | PAD.RIGHT);
	assert.equal(stickMask(-0.6, 0.6), PAD.DOWN | PAD.LEFT);
});

test('a slight lean stays on one axis: the eight sectors are equal', () => {
	// ~11 degrees off the horizontal: still a clean right, or no game that
	// needs pure left and right is playable.
	assert.equal(stickMask(1, -0.2), PAD.RIGHT);
	// ~34 degrees: past the halfway point, so the player asked for a diagonal.
	assert.equal(stickMask(1, -0.67), PAD.UP | PAD.RIGHT);
});

test('the dead zone is a radius, not a per-axis threshold', () => {
	// Both components are below the dead zone, but the vector is not.
	assert.equal(stickMask(0.28, -0.28), PAD.UP | PAD.RIGHT);
});

test('a pressed button is in the mask until it is released', () => {
	const pad = new TouchPad();
	assert.equal(pad.mask, 0);
	pad.press('a');
	assert.equal(pad.mask, PAD.A);
	pad.release('a');
	assert.equal(pad.mask, 0);
});

test('buttons and the stick are held apart', () => {
	const pad = new TouchPad();
	pad.press('a');
	pad.setStick(0, -1);
	assert.equal(pad.mask, PAD.A | PAD.UP);
	// Centring the stick must not drop the button the other thumb is holding.
	pad.setStick(0, 0);
	assert.equal(pad.mask, PAD.A);
});

test('two buttons at once, because a SNES has two thumbs', () => {
	const pad = new TouchPad();
	pad.press('b');
	pad.press('y');
	assert.equal(pad.mask, PAD.B | PAD.Y);
	pad.release('b');
	assert.equal(pad.mask, PAD.Y);
});

test('releaseAll clears everything: the pad going away must not jam a button', () => {
	const pad = new TouchPad();
	pad.press('start');
	pad.setStick(-1, 0);
	pad.releaseAll();
	assert.equal(pad.mask, 0);
});

/**
 * The collector is where the pad stops being a widget and becomes emulation.
 * A collector that ignores the touch pad gives a room that draws a controller
 * nobody can play with, which looks exactly like a broken emulator.
 */

const KEY_CONFIG = {
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA',
	l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight'
};

const CONTROLS = { keys: KEY_CONFIG, pad: STANDARD_PAD };

/** A player with no keyboard and no controller: a phone. */
const NOTHING: { keyboard: boolean; pads: number[] } = { keyboard: false, pads: [] };

test('a collector with no touch pad reads nothing from one', () => {
	const collector = new InputCollector(CONTROLS, NOTHING);
	assert.equal(collector.read(), 0);
});

test('what the thumbs hold reaches the emulator through the collector', () => {
	const pad = new TouchPad();
	const collector = new InputCollector(CONTROLS, NOTHING);
	collector.setTouchPad(pad);

	pad.press('a');
	pad.setStick(0, -1);
	assert.equal(collector.read(), PAD.A | PAD.UP);
});

test('opposing directions from the pad are sanitised like any others', () => {
	const pad = new TouchPad();
	const collector = new InputCollector(CONTROLS, NOTHING);
	collector.setTouchPad(pad);

	pad.press('left');
	pad.press('right');
	assert.equal(collector.read(), PAD.LEFT);
});

test('dropping the touch pad silences it, even mid-press', () => {
	const pad = new TouchPad();
	const collector = new InputCollector(CONTROLS, NOTHING);
	collector.setTouchPad(pad);
	pad.press('start');

	collector.setTouchPad(null);
	assert.equal(collector.read(), 0);
});

/**
 * When to draw it at all.
 *
 * Getting this wrong is visible in both directions: a pad on a desktop eats a
 * third of the picture for nothing, and no pad on a phone leaves a game that
 * runs and cannot be played.
 */

test('a phone with nothing plugged in gets the pad', () => {
	assert.equal(shouldShowTouchPad({ coarsePointer: true, maxTouchPoints: 5, padCount: 0 }), true);
});

test('a real controller wins: it is better than a drawing of one', () => {
	assert.equal(shouldShowTouchPad({ coarsePointer: true, maxTouchPoints: 5, padCount: 1 }), false);
});

test('a desktop with a mouse never gets the pad', () => {
	assert.equal(shouldShowTouchPad({ coarsePointer: false, maxTouchPoints: 0, padCount: 0 }), false);
});

test('a laptop with a touch screen and a mouse keeps its screen', () => {
	// Fine pointer available: the player has a keyboard, and the pad would only
	// take room away from the picture.
	assert.equal(shouldShowTouchPad({ coarsePointer: false, maxTouchPoints: 10, padCount: 0 }), false);
});

test('a coarse pointer that cannot touch - a TV remote - gets nothing', () => {
	assert.equal(shouldShowTouchPad({ coarsePointer: true, maxTouchPoints: 0, padCount: 0 }), false);
});

/**
 * The two rooms ask the same question, so they ask it in one place. Passing the
 * window in keeps that place testable: `matchMedia` is the only way to know a
 * finger is the primary pointer, and there is no faking it from the outside.
 */

test('a phone answers yes to both browser questions', () => {
	const view = {
		matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
		navigator: { maxTouchPoints: 5 }
	};
	assert.equal(touchPadWanted(0, view), true);
	assert.equal(touchPadWanted(1, view), false);
});

test('a desktop browser answers no, and one without matchMedia is not a phone', () => {
	const desktop = {
		matchMedia: () => ({ matches: false }),
		navigator: { maxTouchPoints: 0 }
	};
	assert.equal(touchPadWanted(0, desktop), false);
	assert.equal(touchPadWanted(0, {}), false);
});
