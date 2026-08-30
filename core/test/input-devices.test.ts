/**
 * Assigning controllers to players.
 *
 * Two players on one machine are separated by nothing else. A resolution that
 * hands the same pad to both produces one controller driving both ports -
 * exactly the symptom being fixed - and one that hands a pad to nobody produces
 * a silent player with no error message.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
	assignmentFor,
	choiceOf,
	editedTable,
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

/** A test `localStorage`: the same API, in memory. */
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

test('the defaults reproduce today\'s solo behaviour', () => {
	const a = defaultAssignments();
	assert.deepEqual(a.p1, { keyboard: true, gamepad: 'auto' });
	assert.deepEqual(a.p2, { keyboard: false, gamepad: null });
	assert.ok(isPlayerActive(a.p1));
	assert.ok(!isPlayerActive(a.p2), 'player 2 is silent until it has a device');
});

test('a player becomes active as soon as it has a device', () => {
	assert.ok(isPlayerActive({ keyboard: true, gamepad: null }));
	assert.ok(isPlayerActive({ keyboard: false, gamepad: 'auto' }));
	assert.ok(isPlayerActive({ keyboard: false, gamepad: { id: 'x', index: 0 } }));
	assert.ok(!isPlayerActive({ keyboard: false, gamepad: null }));
});

test("a lone player on 'auto' reads every pad, as today", () => {
	const sources = resolveSources(defaultAssignments(), PADS);
	assert.deepEqual(sources.p1.pads, [0, 1]);
	assert.equal(sources.p1.keyboard, true);
	assert.deepEqual(sources.p2.pads, []);
	assert.equal(sources.p2.keyboard, false);
});

test("'auto' stops reading the pad the other player claimed", () => {
	// The original symptom: without this, player 2's pad also drives player 1.
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

test('a pad is found by its id, even when its index changed', () => {
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

test('the index is the fallback when the id says nothing', () => {
	// Two identical controllers share one id: something has to separate them.
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

test('an unplugged pad yields nothing at all', () => {
	const sources = resolveSources(
		{
			p1: { keyboard: true, gamepad: { id: 'Parti', index: 7 } },
			p2: { keyboard: false, gamepad: null }
		},
		PADS
	);

	assert.deepEqual(sources.p1.pads, [], 'and above all not the first pad that happens to be there');
});

test('two claims on the same pad are not arbitrated', () => {
	// Both read it; the conflict detection is what says so on screen. Deciding
	// here would leave a player silent with no explanation.
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

test('a round trip through storage preserves everything', () => {
	const storage = fakeStorage();
	const assignments = {
		p1: { keyboard: false, gamepad: { id: PADS[0].id, index: 0 } },
		p2: { keyboard: true, gamepad: { id: PADS[1].id, index: 1 } }
	};
	saveAssignments(storage, assignments);
	assert.deepEqual(loadAssignments(storage), assignments);
});

test('the old key is migrated then erased', () => {
	for (const [legacy, expected] of [
		['auto', 'auto'],
		['off', null],
		['2', { id: '', index: 2 }]
	] as const) {
		const storage = fakeStorage({ [LEGACY_SOURCE_KEY]: legacy });
		const assignments = loadAssignments(storage);

		assert.deepEqual(assignments.p1.gamepad, expected, `${legacy} migrated wrong`);
		assert.equal(assignments.p1.keyboard, true);
		assert.deepEqual(assignments.p2, { keyboard: false, gamepad: null });
		assert.equal(storage.getItem(LEGACY_SOURCE_KEY), null, 'the old key disappears');
		assert.ok(storage.getItem(DEVICES_STORAGE_KEY), 'the new one is written');
	}
});

test('an unreadable legacy value falls back to the defaults', () => {
	const storage = fakeStorage({ [LEGACY_SOURCE_KEY]: 'n’importe quoi' });
	assert.deepEqual(loadAssignments(storage).p1.gamepad, 'auto');
});

test('empty or corrupt storage yields the defaults', () => {
	assert.deepEqual(loadAssignments(fakeStorage()), defaultAssignments());
	assert.deepEqual(
		loadAssignments(fakeStorage({ [DEVICES_STORAGE_KEY]: '{ not json' })),
		defaultAssignments()
	);
	assert.deepEqual(
		loadAssignments(fakeStorage({ [DEVICES_STORAGE_KEY]: '{"p1":{"gamepad":"n\'importe"}}' })),
		defaultAssignments()
	);
});

test('a pad\'s display name loses its USB identifier', () => {
	assert.equal(padDisplayName(PADS[0].id), '8BitDo SN30');
	assert.equal(padDisplayName('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), 'Xbox 360 Controller');
	assert.equal(padDisplayName('  '), '');
});

test('enumerating pads survives a missing API', () => {
	assert.deepEqual(connectedPads({} as Navigator), []);
	assert.deepEqual(
		connectedPads({
			getGamepads: () => [
				{ index: 0, id: 'A pad', connected: true },
				null,
				{ index: 2, id: 'Virtual Gamepad 1', connected: true },
				{ index: 3, id: 'Unplugged', connected: false }
			]
		} as unknown as Navigator),
		[{ index: 0, id: 'A pad' }],
		'virtual and disconnected pads do not count'
	);
});

test("withSingleAuto demotes player 2 when both are 'auto'", () => {
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
	assert.deepEqual(withSingleAuto(untouched), untouched, 'a single auto changes nothing');
});

test("hand-edited storage with both players on 'auto' is corrected on load", () => {
	const storage = fakeStorage({
		[DEVICES_STORAGE_KEY]: JSON.stringify({
			p1: { keyboard: true, gamepad: 'auto' },
			p2: { keyboard: false, gamepad: 'auto' }
		})
	});

	assert.deepEqual(loadAssignments(storage).p2.gamepad, null);
});

test("two 'auto's in memory do not bring the original bug back: player 1 takes all, player 2 none", () => {
	// The regression test for the original symptom: without the guard
	// in resolveSources, `claimed.p1 = claimed.p2 = []` and both players would
	// receive every pad.
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

test('a corrupt gamepad field does not lose the player\'s valid keyboard choice', () => {
	const storage = fakeStorage({
		[DEVICES_STORAGE_KEY]: JSON.stringify({
			p1: { keyboard: false, gamepad: 'garbage' }
		})
	});

	const assignments = loadAssignments(storage);
	assert.equal(assignments.p1.keyboard, false, 'a deliberately disabled keyboard must survive');
	assert.equal(assignments.p1.gamepad, 'auto', 'only the invalid field falls back to the default');
});

/* ------------------------------------------------------- the device choice */

test('the four device choices map onto the stored assignment shape', () => {
	assert.deepEqual(assignmentFor({ kind: 'auto' }), { keyboard: true, gamepad: 'auto' });
	assert.deepEqual(assignmentFor({ kind: 'keyboard' }), { keyboard: true, gamepad: null });
	assert.deepEqual(assignmentFor({ kind: 'none' }), { keyboard: false, gamepad: null });

	const ref = { id: PADS[0].id, index: 0 };
	assert.deepEqual(assignmentFor({ kind: 'pad', ref }), { keyboard: false, gamepad: ref });
});

test('a stored assignment reads back as the choice that produced it', () => {
	for (const choice of [
		{ kind: 'auto' },
		{ kind: 'keyboard' },
		{ kind: 'none' },
		{ kind: 'pad', ref: { id: PADS[1].id, index: 1 } }
	] as const) {
		assert.deepEqual(choiceOf(assignmentFor(choice)), choice, `${choice.kind} does not round-trip`);
	}
});

test('shapes the new dropdown cannot produce still read as their nearest choice', () => {
	// The old UI could set a keyboard AND an explicit pad at once. Such a row
	// survives in localStorage, and the dropdown has to show something for it:
	// the pad, since that is the more specific of the two.
	const ref = { id: PADS[0].id, index: 0 };
	assert.deepEqual(choiceOf({ keyboard: true, gamepad: ref }), { kind: 'pad', ref });
	// Pads-only auto is likewise not offered; auto is auto.
	assert.deepEqual(choiceOf({ keyboard: false, gamepad: 'auto' }), { kind: 'auto' });
});

test('the drawing follows the device, which is what replaced the table tabs', () => {
	assert.equal(editedTable({ kind: 'keyboard' }), 'keys');
	assert.equal(editedTable({ kind: 'auto' }), 'keys', 'auto tunes the keyboard; the pad keeps the standard mapping');
	assert.equal(editedTable({ kind: 'none' }), 'keys');
	assert.equal(editedTable({ kind: 'pad', ref: { id: 'x', index: 0 } }), 'pad');
});
