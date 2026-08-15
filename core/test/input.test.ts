/**
 * Input collection tests.
 *
 * The browser input path is the one part of lockstep netplay that the session
 * tests cannot reach: they inject pads directly. A collector that silently
 * returns 0 produces a session that runs perfectly and ignores the player,
 * which is exactly what a desync test would call a success.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { InputCollector } from '../../frontend/src/lib/znet/input.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';

const KEY_CONFIG = {
	up: 'ArrowUp',
	down: 'ArrowDown',
	left: 'ArrowLeft',
	right: 'ArrowRight',
	a: 'KeyX',
	b: 'KeyZ',
	x: 'KeyS',
	y: 'KeyA',
	l: 'KeyQ',
	r: 'KeyW',
	start: 'Enter',
	select: 'ShiftRight'
};

/** Minimal stand-in for the pieces of `window` the collector touches. */
function fakeWindow() {
	const listeners = new Map<string, Array<(e: unknown) => void>>();
	return {
		addEventListener(type: string, handler: (e: unknown) => void) {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type)!.push(handler);
		},
		removeEventListener(type: string, handler: (e: unknown) => void) {
			const list = listeners.get(type);
			if (!list) return;
			const i = list.indexOf(handler);
			if (i >= 0) list.splice(i, 1);
		},
		fire(type: string, event: Record<string, unknown>) {
			for (const handler of listeners.get(type) ?? []) {
				handler({ preventDefault() {}, ...event });
			}
		},
		listenerCount(type: string) {
			return (listeners.get(type) ?? []).length;
		}
	};
}

function withoutGamepads<T>(fn: () => T): T {
	// The collector merges gamepad state into every read; node has no gamepad
	// API, and the code must cope with that rather than throw.
	const original = (globalThis as { navigator?: unknown }).navigator;
	try {
		return fn();
	} finally {
		if (original !== undefined) {
			Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
		}
	}
}

test('a pressed key becomes the right pad bit', () => {
	withoutGamepads(() => {
		const win = fakeWindow();
		const collector = new InputCollector(KEY_CONFIG);
		collector.attach(win as never);

		assert.equal(collector.read(), 0, 'nothing held means an empty mask');

		win.fire('keydown', { code: 'KeyX' });
		assert.equal(collector.read(), PAD.A, 'KeyX is mapped to A');

		win.fire('keydown', { code: 'Enter' });
		assert.equal(collector.read(), PAD.A | PAD.START);

		win.fire('keyup', { code: 'KeyX' });
		assert.equal(collector.read(), PAD.START);

		collector.detach(win as never);
	});
});

test('every configured button maps to a distinct bit', () => {
	withoutGamepads(() => {
		const win = fakeWindow();
		const collector = new InputCollector(KEY_CONFIG);
		collector.attach(win as never);

		const seen = new Map<number, string>();
		for (const [button, code] of Object.entries(KEY_CONFIG)) {
			win.fire('keydown', { code });
			const mask = collector.read();
			assert.notEqual(mask, 0, `${button} (${code}) produced no bit`);
			assert.ok(!seen.has(mask), `${button} collides with ${seen.get(mask)}`);
			seen.set(mask, button);
			win.fire('keyup', { code });
			assert.equal(collector.read(), 0, `${button} stayed held after keyup`);
		}
		assert.equal(seen.size, 12, 'all twelve SNES buttons must be reachable');

		collector.detach(win as never);
	});
});

test('unmapped keys are ignored', () => {
	withoutGamepads(() => {
		const win = fakeWindow();
		const collector = new InputCollector(KEY_CONFIG);
		collector.attach(win as never);

		win.fire('keydown', { code: 'KeyP' });
		assert.equal(collector.read(), 0);

		collector.detach(win as never);
	});
});

test('opposing directions are never reported together', () => {
	withoutGamepads(() => {
		const win = fakeWindow();
		const collector = new InputCollector(KEY_CONFIG);
		collector.attach(win as never);

		win.fire('keydown', { code: 'ArrowLeft' });
		win.fire('keydown', { code: 'ArrowRight' });
		const mask = collector.read();
		assert.notEqual(mask & PAD.LEFT, 0, 'the first direction wins');
		assert.equal(mask & PAD.RIGHT, 0, 'both directions at once is not a state a pad can be in');

		collector.detach(win as never);
	});
});

test('losing focus releases everything', () => {
	withoutGamepads(() => {
		const win = fakeWindow();
		const collector = new InputCollector(KEY_CONFIG);
		collector.attach(win as never);

		win.fire('keydown', { code: 'ArrowUp' });
		assert.equal(collector.read(), PAD.UP);

		win.fire('blur', {});
		// A key still held when the window loses focus never gets its keyup, and
		// in lockstep that is a direction jammed on for both players.
		assert.equal(collector.read(), 0, 'blur must clear held keys');

		collector.detach(win as never);
	});
});

test('a remapped config takes effect and drops the old binding', () => {
	withoutGamepads(() => {
		const win = fakeWindow();
		const collector = new InputCollector(KEY_CONFIG);
		collector.attach(win as never);

		collector.setKeyConfig({ ...KEY_CONFIG, a: 'KeyM' });

		win.fire('keydown', { code: 'KeyM' });
		assert.equal(collector.read(), PAD.A, 'the new binding must work');

		win.fire('keyup', { code: 'KeyM' });
		win.fire('keydown', { code: 'KeyX' });
		assert.equal(collector.read(), 0, 'the old binding must stop working');

		collector.detach(win as never);
	});
});

test('detach stops listening', () => {
	withoutGamepads(() => {
		const win = fakeWindow();
		const collector = new InputCollector(KEY_CONFIG);
		collector.attach(win as never);
		collector.detach(win as never);

		assert.equal(win.listenerCount('keydown'), 0);
		win.fire('keydown', { code: 'KeyX' });
		assert.equal(collector.read(), 0);
	});
});

/* ---------------------------------------------------------------- gamepads */

/** Installs fake pads on globalThis.navigator for the duration of `fn`. */
function withGamepads<T>(pads: Array<{ index: number; buttons: number[] }>, fn: () => T): T {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	const fake = {
		getGamepads: () =>
			pads.map((p) => ({
				index: p.index,
				connected: true,
				buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: p.buttons.includes(i) })),
				axes: [0, 0]
			}))
	};
	Object.defineProperty(globalThis, 'navigator', { value: fake, configurable: true });
	try {
		return fn();
	} finally {
		if (previous) Object.defineProperty(globalThis, 'navigator', previous);
		else delete (globalThis as { navigator?: unknown }).navigator;
	}
}

test("'auto' merges every pad, which is what makes one controller drive two windows", () => {
	// Not a bug in itself - it is right for one player at one machine - but it
	// is why an explicit choice has to exist.
	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(KEY_CONFIG, 'auto');
		assert.equal(collector.read(), PAD.A, 'button 1 is A');
	});
});

test("'off' leaves the player on the keyboard alone", () => {
	const win = fakeWindow();
	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(KEY_CONFIG, 'off');
		collector.attach(win as never);
		assert.equal(collector.read(), 0, 'the pad must be ignored entirely');

		win.fire('keydown', { code: 'KeyX' });
		assert.equal(collector.read(), PAD.A, 'the keyboard must still work');
		collector.detach(win as never);
	});
});

test('an explicit index listens to that pad and no other', () => {
	withGamepads(
		[
			{ index: 0, buttons: [1] }, // A
			{ index: 1, buttons: [3] } // X
		],
		() => {
			const first = new InputCollector(KEY_CONFIG, 0);
			const second = new InputCollector(KEY_CONFIG, 1);
			assert.equal(first.read(), PAD.A);
			assert.equal(second.read(), PAD.X);

			// The case that started this: two players, one machine, two windows.
			// With distinct sources a press on pad 0 must not reach player two.
			assert.equal(first.read() & second.read(), 0, 'the two must not overlap');
		}
	);
});

test('the source can be changed at runtime and the pads enumerated', () => {
	withGamepads([{ index: 0, buttons: [1] }, { index: 2, buttons: [] }], () => {
		const collector = new InputCollector(KEY_CONFIG, 'auto');
		assert.deepEqual(collector.connectedGamepads(), [0, 2]);

		assert.equal(collector.read(), PAD.A);
		collector.setGamepadSource('off');
		assert.equal(collector.read(), 0);
		collector.setGamepadSource(2);
		assert.equal(collector.read(), 0, 'pad 2 has nothing pressed');
		collector.setGamepadSource(0);
		assert.equal(collector.read(), PAD.A);
	});
});

test('a missing gamepad API is not an error', () => {
	// node has none, and neither do some locked-down browser contexts.
	const collector = new InputCollector(KEY_CONFIG, 'auto');
	assert.equal(collector.read(), 0);
	assert.deepEqual(collector.connectedGamepads(), []);
});
