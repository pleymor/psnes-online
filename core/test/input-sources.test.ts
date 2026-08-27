/**
 * `input-sources.ts`, the module that points each player's collector at
 * whatever device is currently assigned.
 *
 * `connectedPads()` and `loadAssignments()` (both from `znet/devices.ts`) are
 * left real; what is faked is what they read from - `navigator.getGamepads`
 * via a globalThis swap (same pattern as `room-chrome.test.ts`'s fake
 * `document`) and an in-memory `Storage`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInputSources, type SourceTarget } from '../../frontend/src/lib/rooms/input-sources.js';
import type { InputSources } from '../../frontend/src/lib/controls/binding.js';

// ------------------------------------------------------------------- fakes

class FakeStorage implements Storage {
	private data = new Map<string, string>();
	get length(): number {
		return this.data.size;
	}
	getItem(key: string): string | null {
		return this.data.has(key) ? this.data.get(key)! : null;
	}
	setItem(key: string, value: string): void {
		this.data.set(key, value);
	}
	removeItem(key: string): void {
		this.data.delete(key);
	}
	clear(): void {
		this.data.clear();
	}
	key(index: number): string | null {
		return [...this.data.keys()][index] ?? null;
	}
}

interface FakeGamepad {
	connected: boolean;
	id: string;
	index: number;
}

/** Installs a fake `navigator.getGamepads` for the duration of `run`. */
async function withPads(pads: FakeGamepad[], run: () => Promise<void> | void): Promise<void> {
	const g = globalThis as unknown as { navigator: unknown };
	const saved = g.navigator;
	g.navigator = { getGamepads: () => pads };
	try {
		await run();
	} finally {
		g.navigator = saved;
	}
}

function spyCollector(): SourceTarget & { calls: InputSources[] } {
	const calls: InputSources[] = [];
	return {
		calls,
		setSources: (source: InputSources) => calls.push(source)
	};
}

// pad indices are what `connectedPads` reports for a *connected*, non-virtual
// gamepad - see devices.ts's own filter.
const PAD_1: FakeGamepad = { connected: true, id: 'Pad One', index: 0 };
const PAD_2: FakeGamepad = { connected: true, id: 'Pad Two', index: 1 };
const DISCONNECTED: FakeGamepad = { connected: false, id: 'Ghost Pad', index: 2 };
const VIRTUAL: FakeGamepad = { connected: true, id: 'Virtual Gamepad (touch)', index: 3 };

// ----------------------------------------------------------------------- tests

test('a two-element collector array (solo) wires p1 to slot 0 and p2 to slot 1', () =>
	withPads([PAD_1], () => {
		const storage = new FakeStorage();
		const p1 = spyCollector();
		const p2 = spyCollector();

		const { assignments } = applyInputSources(storage, [p1, p2]);

		assert.equal(p1.calls.length, 1);
		assert.equal(p2.calls.length, 1);
		// Defaults: p1 is keyboard + auto, p2 is silent - so p1 gets the one pad,
		// p2 gets nothing. This also proves each collector received *its own*
		// player's source, not the other one's.
		assert.deepEqual(p1.calls[0], { keyboard: true, pads: [0] });
		assert.deepEqual(p2.calls[0], { keyboard: false, pads: [] });
		assert.equal(assignments.p1.gamepad, 'auto');
	}));

test('a one-element collector array (lockstep) wires only slot 0, and never touches p2', () =>
	withPads([PAD_1], () => {
		const storage = new FakeStorage();
		const p1 = spyCollector();

		applyInputSources(storage, [p1]);

		assert.equal(p1.calls.length, 1);
		assert.deepEqual(p1.calls[0], { keyboard: true, pads: [0] });
	}));

test('a null collector in a slot is skipped rather than throwing', () =>
	withPads([PAD_1], () => {
		const storage = new FakeStorage();
		const p2 = spyCollector();

		assert.doesNotThrow(() => applyInputSources(storage, [null, p2]));
		assert.equal(p2.calls.length, 1);
	}));

test('padCount counts only connected, non-virtual pads', () =>
	withPads([PAD_1, PAD_2, DISCONNECTED, VIRTUAL], () => {
		const storage = new FakeStorage();

		const { padCount } = applyInputSources(storage, []);

		assert.equal(padCount, 2, 'a disconnected pad and the on-screen virtual pad must not be counted');
	}));

test('padCount is 0 with nothing plugged in', () =>
	withPads([], () => {
		const storage = new FakeStorage();

		const { padCount } = applyInputSources(storage, []);

		assert.equal(padCount, 0);
	}));

test('an explicit assignment in storage is honoured, not overridden by auto', () =>
	withPads([PAD_1, PAD_2], () => {
		const storage = new FakeStorage();
		storage.setItem(
			'psnes-input-devices',
			JSON.stringify({
				p1: { keyboard: false, gamepad: { id: 'Pad Two', index: 1 } },
				p2: { keyboard: true, gamepad: 'auto' }
			})
		);
		const p1 = spyCollector();
		const p2 = spyCollector();

		applyInputSources(storage, [p1, p2]);

		// p1 explicitly claimed pad 1 (by id) - p2's 'auto' must get what is left,
		// pad 0, not pad 1 too.
		assert.deepEqual(p1.calls[0], { keyboard: false, pads: [1] });
		assert.deepEqual(p2.calls[0], { keyboard: true, pads: [0] });
	}));
