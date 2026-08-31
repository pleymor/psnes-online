/**
 * The on-screen pad, on a phone or a tablet.
 *
 * Everything here is the arithmetic between a thumb and a libretro mask. The
 * component that draws the pad is deliberately logic-free, so this is the only
 * place where a wrong sector, a missing dead zone or a button that never gets
 * its release can be caught - and a stuck button on a touch screen is worse
 * than on a keyboard, since there is no second device to press the key again.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
	TouchPad,
	crossMask,
	facesAt,
	readDirectionMode,
	shouldShowTouchPad,
	stickMask,
	touchPadWanted,
	writeDirectionMode
} from '../../frontend/src/lib/controls/touch.js';
import { InputCollector } from '../../frontend/src/lib/znet/input.js';
import type { FaceTarget } from '../../frontend/src/lib/controls/touch.js';
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

/* ------------------------------------------------------------- the cross */

test('the middle of the cross holds nothing', () => {
	assert.equal(crossMask(0, 0), 0);
});

test('each arm of the cross is its own direction, and only it', () => {
	assert.equal(crossMask(1, 0), PAD.RIGHT);
	assert.equal(crossMask(-1, 0), PAD.LEFT);
	assert.equal(crossMask(0, -1), PAD.UP);
	assert.equal(crossMask(0, 1), PAD.DOWN);
});

test('a corner of the cross is a diagonal, which games ask for', () => {
	assert.equal(crossMask(1, -1), PAD.RIGHT | PAD.UP);
});

test('the cross rests on a square plateau where the stick would already lean', () => {
	// The difference that makes a cross worth offering. A stick is measured by
	// angle from its centre, so a thumb a third of the way out is already a
	// firm diagonal; a cross has a flat middle you can rest a thumb on, and
	// only the arms mean anything. A player who keeps a thumb parked wants the
	// second behaviour, which is the whole reason the choice exists.
	assert.equal(crossMask(0.3, 0.3), 0, 'the plateau of a cross');
	assert.equal(stickMask(0.3, 0.3), PAD.RIGHT | PAD.DOWN, 'the same thumb on a stick');
});

test('a thumb that slides off the end of an arm is still holding it', () => {
	// A cross is drawn at a fixed place and the thumb wanders; running past the
	// end of the arm is a normal gesture, not a release.
	assert.equal(crossMask(2, 0), PAD.RIGHT);
	assert.equal(crossMask(0, -3.5), PAD.UP);
});

test('changing the shape lets go of the direction held on the old one', () => {
	// Otherwise the direction the thumb was holding when the player reached for
	// the toggle stays pressed for ever: the pointer that would have released it
	// belongs to a control that no longer exists.
	const pad = new TouchPad();
	pad.setDirection(1, 0);
	assert.equal(pad.mask, PAD.RIGHT);
	pad.setMode('cross');
	assert.equal(pad.mask, 0, 'the old direction must not survive the switch');
});

test('the pad maps a thumb through whichever shape is showing', () => {
	const pad = new TouchPad();
	pad.setDirection(0.3, 0.3);
	assert.equal(pad.mask, PAD.RIGHT | PAD.DOWN, 'stick by default');
	pad.setMode('cross');
	pad.setDirection(0.3, 0.3);
	assert.equal(pad.mask, 0, 'the same thumb, on a cross');
});

test('the chosen shape is remembered per device, and a fresh device gets the stick', () => {
	// Per device on purpose: the same account plays on a phone and on a desktop,
	// and a shape chosen for a thumb has no business following the player to a
	// machine with a keyboard.
	const store = new Map<string, string>();
	const view = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v)
	};
	assert.equal(readDirectionMode(view), 'stick', 'the default the header argues for');
	writeDirectionMode('cross', view);
	assert.equal(readDirectionMode(view), 'cross');
	writeDirectionMode('stick', view);
	assert.equal(readDirectionMode(view), 'stick');
});

test('a device that refuses storage still gets a working pad', () => {
	// Private browsing throws on both calls rather than returning null.
	const hostile = {
		getItem: () => {
			throw new Error('denied');
		},
		setItem: () => {
			throw new Error('denied');
		}
	};
	assert.equal(readDirectionMode(hostile), 'stick');
	assert.doesNotThrow(() => writeDirectionMode('cross', hostile));
});

test('a stored value that means nothing is not trusted', () => {
	const store = new Map<string, string>([['psnes-touch-shape', 'trackball']]);
	const view = { getItem: (k: string) => store.get(k) ?? null, setItem: () => {} };
	assert.equal(readDirectionMode(view), 'stick');
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
	pad.setDirection(0, -1);
	assert.equal(pad.mask, PAD.A | PAD.UP);
	// Centring the stick must not drop the button the other thumb is holding.
	pad.setDirection(0, 0);
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
	pad.setDirection(-1, 0);
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
	pad.setDirection(0, -1);
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

/**
 * One thumb, two buttons.
 *
 * A SNES asks for A+B or Y+B in the same moment, and a thumb is wider than the
 * gap between two face buttons. Sending whichever button happens to be under
 * the contact point loses those inputs; sending nothing at all - which is what
 * the gap between two circles gives you - is worse, and it is exactly where a
 * player aiming at both puts their thumb.
 *
 * The geometry below is the real diamond: a 130px square, buttons 36% of it.
 */
const R = 23.4;
const DIAMOND: FaceTarget[] = [
	{ button: 'x', x: 65, y: 23.4 },
	{ button: 'y', x: 23.4, y: 65 },
	{ button: 'a', x: 106.6, y: 65 },
	{ button: 'b', x: 65, y: 106.6 }
].map((t) => ({ ...t, r: R })) as FaceTarget[];

test('a thumb on a button presses that button, and only it', () => {
	assert.deepEqual(facesAt(106.6, 65, DIAMOND), ['a']);
	assert.deepEqual(facesAt(65, 23.4, DIAMOND), ['x']);
});

test('a thumb in the gap between A and B presses both', () => {
	// Halfway between the two centres: the point a player aiming at both picks.
	assert.deepEqual(new Set(facesAt(85.8, 85.8, DIAMOND)), new Set(['a', 'b']));
});

test('a thumb slightly off centre still presses only its own button', () => {
	// A few pixels toward B from A's centre is still a deliberate A.
	assert.deepEqual(facesAt(103, 72, DIAMOND), ['a']);
});

test('never three at once: a thumb is not that wide', () => {
	for (const [x, y] of [[85.8, 85.8], [65, 65], [95, 50], [45, 45]]) {
		assert.ok(facesAt(x, y, DIAMOND).length <= 2, `${x},${y} pressed too many`);
	}
});

test('the middle of the diamond still plays something', () => {
	// Equidistant from all four. Pressing nothing there is a dead spot in the
	// middle of the one control the player uses most.
	assert.ok(facesAt(65, 65, DIAMOND).length >= 1);
});

test('a thumb outside the diamond presses nothing', () => {
	assert.deepEqual(facesAt(-40, -40, DIAMOND), []);
	assert.deepEqual(facesAt(65, 200, DIAMOND), []);
});
