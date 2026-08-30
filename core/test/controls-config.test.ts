/**
 * Normalisation of the controls config.
 *
 * This module is the only door a config comes through into the front end:
 * a v1 shape from the database, an already-normalised v2, or anything at all.
 * A normalisation that lets a hole through produces a player one of whose
 * button that does not respond, and nothing upstream catches it.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
	BUTTONS,
	DEFAULT_P1_KEYS,
	DEFAULT_P2_KEYS,
	STANDARD_PAD,
	defaultControlsConfig,
	describeCode,
	findConflicts,
	isPadCode,
	legacyToPadCode,
	normaliseControlsConfig,
	parsePadCode,
	shortLabel,
	shortLabelList
} from '../../frontend/src/lib/controls/binding.js';

const V1 = {
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA',
	l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight'
};

test('the twelve SNES buttons, and nothing more', () => {
	assert.equal(BUTTONS.length, 12);
	assert.deepEqual([...BUTTONS].sort(), [
		'a', 'b', 'down', 'l', 'left', 'r', 'right', 'select', 'start', 'up', 'x', 'y'
	]);
});

test('the two players\' defaults never intersect', () => {
	const p1 = new Set(Object.values(DEFAULT_P1_KEYS));
	for (const code of Object.values(DEFAULT_P2_KEYS)) {
		assert.ok(!p1.has(code), `${code} is in both default sets`);
	}
});

test('the standard mapping covers the d-pad by buttons AND by the stick', () => {
	// The hardcoded table it replaces read both. Keeping only one of them would
	// cut the left stick on every XInput controller.
	assert.deepEqual(STANDARD_PAD.up, ['PadButton12', 'PadAxis1Minus']);
	assert.deepEqual(STANDARD_PAD.down, ['PadButton13', 'PadAxis1Plus']);
	assert.deepEqual(STANDARD_PAD.left, ['PadButton14', 'PadAxis0Minus']);
	assert.deepEqual(STANDARD_PAD.right, ['PadButton15', 'PadAxis0Plus']);
	assert.deepEqual(STANDARD_PAD.a, ['PadButton1']);
	assert.deepEqual(STANDARD_PAD.select, ['PadButton8']);
});

test('recognise and split a controller code', () => {
	assert.ok(isPadCode('PadButton12'));
	assert.ok(isPadCode('PadAxis0Minus'));
	assert.ok(!isPadCode('KeyX'));
	assert.ok(!isPadCode('Gamepad0Button2'), 'a legacy code is not a controller code');

	assert.deepEqual(parsePadCode('PadButton12'), { kind: 'button', index: 12 });
	assert.deepEqual(parsePadCode('PadAxis1Plus'), { kind: 'axis', index: 1, dir: 'plus' });
	assert.equal(parsePadCode('KeyX'), null);
});

test('legacy codes lose their device index', () => {
	assert.equal(legacyToPadCode('Gamepad0Button2'), 'PadButton2');
	assert.equal(legacyToPadCode('Gamepad1Button11'), 'PadButton11');
	assert.equal(legacyToPadCode('Gamepad0Axis1Plus'), 'PadAxis1Plus');
	assert.equal(legacyToPadCode('KeyX'), null);
});

test('a bare KeyConfig becomes a complete v2', () => {
	const config = normaliseControlsConfig(V1);

	assert.equal(config.version, 2);
	assert.deepEqual(config.p1.keys, V1, 'player 1\'s keys are taken as they are');
	assert.deepEqual(config.p1.pad, STANDARD_PAD, 'player 1 inherits the standard mapping');
	assert.deepEqual(config.p2.keys, DEFAULT_P2_KEYS, 'player 2 shows up with its defaults');
	assert.deepEqual(config.p2.pad, STANDARD_PAD);
});

test('a v1 config with an emptied slot keeps it empty', () => {
	// '' means unbound everywhere else in the module; substituting the default
	// would resurrect the binding the player removed. The server's copy reads it
	// the same way - the only way the two normalisations agree on this input.
	const config = normaliseControlsConfig({ ...V1, l: '' });

	assert.equal(config.p1.keys.l, '', 'the slot stays unbound');
	assert.equal(config.p1.keys.a, 'KeyX', 'and the rest of the table is carried over');
});

test('a legacy controller code migrates to the pad table and frees the keyboard', () => {
	const config = normaliseControlsConfig({ ...V1, a: 'Gamepad0Button2' });

	assert.deepEqual(config.p1.pad.a, ['PadButton2'], 'the binding moves to the controller side');
	assert.equal(config.p1.keys.a, '', 'and the keyboard slot becomes unbound');
	assert.deepEqual(config.p1.pad.b, STANDARD_PAD.b, 'the other slots do not move');
});

test('migrating a legacy controller code releases the other slots holding it', () => {
	// The standard mapping already gives PadButton2 to Y. If player 1 had rebound
	// A onto it under the old system, leaving it on Y as well would create a
	// conflict the player never chose and would have to resolve before being
	// able to save. The code belongs to the button the player explicitly
	// aimed at; the other button loses the binding, not the player.
	const result = normaliseControlsConfig({ ...V1, a: 'Gamepad0Button2' });

	assert.deepEqual(result.p1.pad.a, ['PadButton2'], 'the migrated binding stays on the button aimed at');
	assert.deepEqual(result.p1.pad.y, [], 'Y gives up the code it shared with A');

	const report = findConflicts(result, BOTH_KEYBOARD);
	assert.equal(report.count, 0, 'no conflict left after the migration');
});

test('a v2 config passes through unrewritten, emptied slots included', () => {
	const input = {
		version: 2,
		p1: { keys: { ...V1, l: '' }, pad: { ...STANDARD_PAD, l: [] } },
		p2: { keys: DEFAULT_P2_KEYS, pad: { ...STANDARD_PAD, a: ['PadButton7'] } }
	};
	const config = normaliseControlsConfig(input);

	assert.equal(config.p1.keys.l, '', 'an emptied keyboard slot stays empty');
	assert.deepEqual(config.p1.pad.l, [], 'an emptied list stays empty');
	assert.deepEqual(config.p2.pad.a, ['PadButton7'], 'a chosen binding is preserved');
});

test('the normalisation is idempotent', () => {
	const once = normaliseControlsConfig(V1);
	assert.deepEqual(normaliseControlsConfig(once), once);
});

test('missing keys are filled in, junk is replaced', () => {
	const partial = normaliseControlsConfig({ version: 2, p1: { keys: { a: 'KeyM' } } });
	assert.equal(partial.p1.keys.a, 'KeyM');
	assert.equal(partial.p1.keys.up, DEFAULT_P1_KEYS.up, 'the rest comes from the defaults');
	assert.deepEqual(partial.p1.pad, STANDARD_PAD, 'a missing pad table means the standard one');

	for (const junk of [null, undefined, 42, 'nope', [], {}, { version: 9 }]) {
		assert.deepEqual(
			normaliseControlsConfig(junk),
			defaultControlsConfig(),
			`${JSON.stringify(junk)} must fall back to the defaults`
		);
	}
});

test('non-controller codes are dropped from the pad table', () => {
	const config = normaliseControlsConfig({
		version: 2,
		p1: { keys: V1, pad: { ...STANDARD_PAD, a: ['KeyX', 'PadButton1', 7] } }
	});
	assert.deepEqual(config.p1.pad.a, ['PadButton1']);
});

/* ------------------------------------------------------------- affichage */

test('a code describes itself without needing words', () => {
	assert.deepEqual(describeCode('KeyX'), { kind: 'keyboard', code: 'KeyX' });
	assert.deepEqual(describeCode('PadButton2'), { kind: 'padButton', index: 2 });
	assert.deepEqual(describeCode('PadAxis0Minus'), { kind: 'padAxis', index: 0, dir: 'minus' });
	assert.deepEqual(describeCode(''), { kind: 'unbound' });
});

test('the short forms fit on a button', () => {
	assert.equal(shortLabel('KeyX'), 'X');
	assert.equal(shortLabel('Digit1'), '1');
	assert.equal(shortLabel('ArrowUp'), '↑');
	assert.equal(shortLabel('ArrowLeft'), '←');
	assert.equal(shortLabel('Enter'), '⏎');
	assert.equal(shortLabel('Space'), '␣');
	assert.equal(shortLabel('ShiftRight'), '⇧D');
	assert.equal(shortLabel('ShiftLeft'), '⇧G');
	assert.equal(shortLabel('ControlLeft'), '⌃G');
	assert.equal(shortLabel('AltRight'), '⌥D');
	assert.equal(shortLabel('Escape'), 'Esc', 'a code the dictionary does not know keeps a readable name');
	assert.equal(shortLabel('PadButton2'), 'B2');
	assert.equal(shortLabel('PadAxis0Minus'), 'A0−');
	assert.equal(shortLabel('PadAxis1Plus'), 'A1+');
	assert.equal(shortLabel(''), '—');
});

test('a code with no known short form is clamped to three characters', () => {
	// The button this is drawn on is three characters wide: a name rendered as
	// it is overflowed the drawing. The long form stays in the aria-label, which
	// is the only place it fits.
	for (const code of ['Semicolon', 'BracketLeft', 'F1', 'Comma', 'NumpadDivide', 'Quote']) {
		assert.ok(
			shortLabel(code).length <= 3,
			`${code} yields "${shortLabel(code)}", which does not fit on a button`
		);
	}
	assert.equal(shortLabel('Semicolon'), 'Sem');
	assert.equal(shortLabel('F1'), 'F1', 'what already fits passes through untouched');
	assert.equal(shortLabel('NumpadDivide'), 'NDi');
	assert.equal(shortLabel('Numpad7'), 'N7', 'the numpad keeps its shape');
});

test('a list states its first code and counts the rest', () => {
	assert.equal(shortLabelList([]), '—');
	assert.equal(shortLabelList(['PadButton12']), 'B12');
	assert.equal(shortLabelList(['PadButton12', 'PadAxis1Minus']), 'B12 +1');
	assert.equal(shortLabelList(['PadButton12', 'PadAxis1Minus', 'PadButton3']), 'B12 +2');
});

/* -------------------------------------------------------------- conflits */

const BOTH_KEYBOARD = {
	p1: { keyboard: true, pads: [] as number[] },
	p2: { keyboard: true, pads: [] as number[] }
};

function config(p1: unknown, p2: unknown = {}) {
	return normaliseControlsConfig({ version: 2, p1, p2 });
}

test('two buttons of one player on the same key: conflict', () => {
	const report = findConflicts(
		config({ keys: { ...DEFAULT_P1_KEYS, b: 'KeyX' } }),
		BOTH_KEYBOARD
	);

	assert.deepEqual([...report.p1.keys.keys()].sort(), ['a', 'b']);
	assert.deepEqual(report.p1.keys.get('a'), [{ player: 1, button: 'b' }]);
	assert.deepEqual(report.p1.keys.get('b'), [{ player: 1, button: 'a' }]);
	assert.equal(report.count, 2);
});

test('a duplicate is flagged even when the player is inactive', () => {
	// They will plug a device in later, and finding the clash then would be worse.
	const report = findConflicts(config({ keys: { ...DEFAULT_P1_KEYS, b: 'KeyX' } }), {
		p1: { keyboard: false, pads: [] },
		p2: { keyboard: false, pads: [] }
	});
	assert.equal(report.p1.keys.size, 2);
});

test('two players on the keyboard sharing a key: conflict', () => {
	const report = findConflicts(
		config({ keys: DEFAULT_P1_KEYS }, { keys: { ...DEFAULT_P2_KEYS, a: 'KeyX' } }),
		BOTH_KEYBOARD
	);

	assert.deepEqual(report.p1.keys.get('a'), [{ player: 2, button: 'a' }]);
	assert.deepEqual(report.p2.keys.get('a'), [{ player: 1, button: 'a' }]);
});

test('same key, but player 2 has no keyboard: no conflict', () => {
	const report = findConflicts(
		config({ keys: DEFAULT_P1_KEYS }, { keys: { ...DEFAULT_P2_KEYS, a: 'KeyX' } }),
		{ p1: { keyboard: true, pads: [] }, p2: { keyboard: false, pads: [] } }
	);

	assert.equal(report.count, 0, 'player 2\'s key is unreachable');
});

test('same controller button on TWO different controllers: no conflict', () => {
	// The reason the per-device model exists. Without this rule, two players
	// players on the standard mapping would conflict on all twelve
	// buttons, and nothing could ever be saved again.
	const report = findConflicts(config({ keys: DEFAULT_P1_KEYS }, { keys: DEFAULT_P2_KEYS }), {
		p1: { keyboard: true, pads: [0] },
		p2: { keyboard: false, pads: [1] }
	});

	assert.equal(report.count, 0);
});

test('same controller button on the SAME controller: conflict', () => {
	const report = findConflicts(config({ keys: DEFAULT_P1_KEYS }, { keys: DEFAULT_P2_KEYS }), {
		p1: { keyboard: true, pads: [0] },
		p2: { keyboard: false, pads: [0] }
	});

	assert.equal(report.p1.pad.size, 12, 'all twelve slots tread on each other');
	assert.deepEqual(report.p1.pad.get('a'), [{ player: 2, button: 'a' }]);
	assert.deepEqual(
		report.p1.pad.get('up'),
		[{ player: 2, button: 'up' }],
		'the d-pad\'s two codes (button + axis) count the same culprit only once'
	);
});

test("'all' intersects everything connected", () => {
	const report = findConflicts(config({ keys: DEFAULT_P1_KEYS }, { keys: DEFAULT_P2_KEYS }), {
		p1: { keyboard: true, pads: 'all' },
		p2: { keyboard: false, pads: [1] }
	});

	// Both players carry the same standard mapping: all twelve buttons tread on
	// tread on each other, in both directions.
	assert.equal(report.count, 24, "'all' includes pad 1");
});

test("'all' against 'all': overlap even with no controller known", () => {
	const report = findConflicts(config({ keys: DEFAULT_P1_KEYS }, { keys: DEFAULT_P2_KEYS }), {
		p1: { keyboard: false, pads: 'all' },
		p2: { keyboard: false, pads: 'all' }
	});

	assert.equal(report.count, 24, "the first pad to appear would be grabbed by both");
});

test("'all' against an empty list: no overlap", () => {
	const report = findConflicts(config({ keys: DEFAULT_P1_KEYS }, { keys: DEFAULT_P2_KEYS }), {
		p1: { keyboard: false, pads: 'all' },
		p2: { keyboard: false, pads: [] }
	});

	assert.equal(report.count, 0, "an empty list listens to nothing");
});

test('a controller duplicate within one player: conflict', () => {
	const report = findConflicts(
		config({ keys: DEFAULT_P1_KEYS, pad: { ...STANDARD_PAD, b: ['PadButton1'] } }),
		{ p1: { keyboard: true, pads: [0] }, p2: { keyboard: false, pads: [] } }
	);

	assert.deepEqual([...report.p1.pad.keys()].sort(), ['a', 'b']);
});

test('a button with two codes aiming at two different culprits: both accumulate', () => {
	// P1's d-pad (up) carries PadButton12 AND PadAxis1Minus. We have
	// each of those two codes by a DIFFERENT button on P2, to check that both
	// culprits accumulate rather than the second overwriting the
	// premier.
	const report = findConflicts(
		config(
			{ keys: DEFAULT_P1_KEYS },
			{
				keys: DEFAULT_P2_KEYS,
				pad: {
					up: [], down: [], left: [], right: [],
					a: [], b: [], x: ['PadButton12'], y: ['PadAxis1Minus'],
					l: [], r: [], start: [], select: []
				}
			}
		),
		{ p1: { keyboard: true, pads: [0] }, p2: { keyboard: false, pads: [0] } }
	);

	assert.deepEqual(report.p1.pad.get('up'), [
		{ player: 2, button: 'x' },
		{ player: 2, button: 'y' }
	]);
	assert.equal(report.count, 3, 'up (chez P1) + x et y (chez P2)');
});

test('unbound slots are never in conflict', () => {
	const report = findConflicts(
		config({ keys: { ...DEFAULT_P1_KEYS, l: '', r: '' }, pad: { ...STANDARD_PAD, l: [], r: [] } }),
		BOTH_KEYBOARD
	);

	assert.equal(report.count, 0, 'three empty slots do not resemble each other');
});
