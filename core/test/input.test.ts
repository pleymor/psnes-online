/**
 * Input collection tests.
 *
 * The browser input path is the one part of lockstep netplay that the session
 * tests cannot reach: they inject pads directly. A collector that silently
 * returns 0 produces a session that runs perfectly and ignores the player,
 * which is exactly what a desync test would call a success.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { InputCollector } from '../../frontend/src/lib/znet/input.js';
import { PAD } from '../../frontend/src/lib/znet/protocol.js';
import { STANDARD_PAD } from '../../frontend/src/lib/controls/binding.js';

const KEY_CONFIG = {
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA',
	l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight'
};

/** The default player: this keyboard, and the standard controller mapping. */
const CONTROLS = { keys: KEY_CONFIG, pad: STANDARD_PAD };

/** Listen to everything, which is what a lone player does. */
const ALL: { keyboard: boolean; pads: 'all' } = { keyboard: true, pads: 'all' };

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
		const collector = new InputCollector(CONTROLS);
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
		const collector = new InputCollector(CONTROLS);
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
		const collector = new InputCollector(CONTROLS);
		collector.attach(win as never);

		win.fire('keydown', { code: 'KeyP' });
		assert.equal(collector.read(), 0);

		collector.detach(win as never);
	});
});

test('opposing directions are never reported together', () => {
	withoutGamepads(() => {
		const win = fakeWindow();
		const collector = new InputCollector(CONTROLS);
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
		const collector = new InputCollector(CONTROLS);
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
		const collector = new InputCollector(CONTROLS);
		collector.attach(win as never);

		collector.setControls({ ...CONTROLS, keys: { ...KEY_CONFIG, a: 'KeyM' } });

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
		const collector = new InputCollector(CONTROLS);
		collector.attach(win as never);
		collector.detach(win as never);

		assert.equal(win.listenerCount('keydown'), 0);
		win.fire('keydown', { code: 'KeyX' });
		assert.equal(collector.read(), 0);
	});
});

/* ---------------------------------------------------------------- gamepads */

/** Installs fake pads on globalThis.navigator for the duration of `fn`. */
function withGamepads<T>(
	pads: Array<{ index: number; buttons: number[]; axes?: number[] }>,
	fn: () => T
): T {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	const fake = {
		getGamepads: () =>
			pads.map((p) => ({
				index: p.index,
				id: `Fake pad ${p.index}`,
				connected: true,
				buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: p.buttons.includes(i) })),
				axes: p.axes ?? [0, 0]
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

test("listening to everything stays the default for a lone player", () => {
	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(CONTROLS, ALL);
		assert.equal(collector.read(), PAD.A, 'button 1 is A in the standard mapping');
	});
});

test("'off' leaves the player on the keyboard alone", () => {
	const win = fakeWindow();
	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(CONTROLS, { keyboard: true, pads: [] });
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
			const first = new InputCollector(CONTROLS, { keyboard: true, pads: [0] });
			const second = new InputCollector(CONTROLS, { keyboard: true, pads: [1] });
			assert.equal(first.read(), PAD.A);
			assert.equal(second.read(), PAD.X);

			// The case that started this: two players, one machine, two windows.
			// With distinct sources a press on pad 0 must not reach player two.
			assert.equal(first.read() & second.read(), 0, 'the two must not overlap');
		}
	);
});

test('the sources change mid-flight', () => {
	withGamepads([{ index: 0, buttons: [1] }, { index: 2, buttons: [] }], () => {
		const collector = new InputCollector(CONTROLS, ALL);
		assert.equal(collector.read(), PAD.A);

		collector.setSources({ keyboard: true, pads: [] });
		assert.equal(collector.read(), 0);

		collector.setSources({ keyboard: true, pads: [2] });
		assert.equal(collector.read(), 0, 'pad 2 has nothing pressed');

		collector.setSources({ keyboard: true, pads: [0] });
		assert.equal(collector.read(), PAD.A);
	});
});

test('a missing gamepad API is not an error', () => {
	// node has none, and neither do some locked-down browser contexts.
	const collector = new InputCollector(CONTROLS, ALL);
	assert.equal(collector.read(), 0);
});

/* ------------------------------------- the controller config is read */

test('the standard mapping gives the same bits as the hardcoded table it replaces', () => {
	// The anti-regression test of this piece: the old read was a hardcoded table
	// the config could not influence.
	const expected: Array<[number, number]> = [
		[0, PAD.B], [1, PAD.A], [2, PAD.Y], [3, PAD.X],
		[4, PAD.L], [5, PAD.R], [8, PAD.SELECT], [9, PAD.START],
		[12, PAD.UP], [13, PAD.DOWN], [14, PAD.LEFT], [15, PAD.RIGHT]
	];

	for (const [button, bit] of expected) {
		withGamepads([{ index: 0, buttons: [button] }], () => {
			const collector = new InputCollector(CONTROLS, ALL);
			assert.equal(collector.read(), bit, `button ${button} must yield ${bit}`);
		});
	}
});

test('the left stick still works the d-pad', () => {
	// It used to via a hardcoded rule. It now does via two PadAxis codes of the
	// standard mapping, and it has to do it identically.
	const cases: Array<[number[], number]> = [
		[[-1, 0], PAD.LEFT],
		[[1, 0], PAD.RIGHT],
		[[0, -1], PAD.UP],
		[[0, 1], PAD.DOWN],
		[[0.3, 0.3], 0]
	];

	for (const [axes, bit] of cases) {
		withGamepads([{ index: 0, buttons: [], axes }], () => {
			const collector = new InputCollector(CONTROLS, ALL);
			assert.equal(collector.read(), bit, `axes ${JSON.stringify(axes)}`);
		});
	}
});

test('a rebound controller binding takes effect', () => {
	withGamepads([{ index: 0, buttons: [7] }], () => {
		const collector = new InputCollector(
			{ keys: KEY_CONFIG, pad: { ...STANDARD_PAD, a: ['PadButton7'] } },
			ALL
		);
		assert.equal(collector.read(), PAD.A, 'button 7 has become A');
	});

	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(
			{ keys: KEY_CONFIG, pad: { ...STANDARD_PAD, a: ['PadButton7'] } },
			ALL
		);
		assert.equal(collector.read(), 0, 'and button 1 no longer is');
	});
});

test('an emptied controller slot responds to nothing', () => {
	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(
			{ keys: KEY_CONFIG, pad: { ...STANDARD_PAD, a: [] } },
			ALL
		);
		assert.equal(collector.read(), 0);
	});
});

test('a player with no keyboard ignores keys', () => {
	const win = fakeWindow();
	withoutGamepads(() => {
		const collector = new InputCollector(CONTROLS, { keyboard: false, pads: [] });
		collector.attach(win as never);

		let prevented = false;
		win.fire('keydown', { code: 'KeyX', preventDefault: () => { prevented = true; } });
		assert.equal(collector.read(), 0, 'player 1\'s keyboard must not reach player 2');
		assert.equal(prevented, false, 'a player with no keyboard must not steal the key from the page');

		collector.detach(win as never);
	});
});

test('taking the keyboard away releases what was held', () => {
	const win = fakeWindow();
	withoutGamepads(() => {
		const collector = new InputCollector(CONTROLS, ALL);
		collector.attach(win as never);
		win.fire('keydown', { code: 'ArrowUp' });
		assert.equal(collector.read(), PAD.UP);

		collector.setSources({ keyboard: false, pads: 'all' });
		assert.equal(collector.read(), 0, 'otherwise the direction stays jammed forever');

		// The key is still held internally at this point: the previous mask was 0
		// only because `read()` skips the keyboard. Turning the keyboard back on
		// without having cleared `held` would make UP reappear on its own, with
		// nothing having been pressed again.
		collector.setSources({ keyboard: true, pads: 'all' });
		assert.equal(collector.read(), 0, 'without the clear, UP would stay jammed once the keyboard returns');

		collector.detach(win as never);
	});
});

test('two players on two pads do not cross', () => {
	withGamepads(
		[
			{ index: 0, buttons: [1] }, // A
			{ index: 1, buttons: [3] } // X
		],
		() => {
			const first = new InputCollector(CONTROLS, { keyboard: false, pads: [0] });
			const second = new InputCollector(CONTROLS, { keyboard: false, pads: [1] });

			assert.equal(first.read(), PAD.A);
			assert.equal(second.read(), PAD.X);
			assert.equal(first.read() & second.read(), 0, 'aucun recouvrement');
		}
	);
});

test('two buttons pressed at once yield both their bits', () => {
	withGamepads([{ index: 0, buttons: [1, 9] }], () => {
		const collector = new InputCollector(CONTROLS, { keyboard: false, pads: [0] });
		assert.equal(collector.read(), PAD.A | PAD.START);
	});
});

test('sanitise() applies to the controller-sourced mask too', () => {
	// STANDARD_PAD binds every direction to both a button and an axis: button 14
	// is LEFT, and the stick pushed right is also RIGHT. A real controller
	// reports both when the d-pad and the stick contradict each other, and
	// sanitise() has to decide for that mask exactly as it does for the
	// keyboard.
	withGamepads([{ index: 0, buttons: [14], axes: [1, 0] }], () => {
		const collector = new InputCollector(CONTROLS, ALL);
		const mask = collector.read();
		assert.notEqual(mask & PAD.LEFT, 0, 'the d-pad button must count');
		assert.equal(mask & PAD.RIGHT, 0, 'the second opposing direction must be dropped');
	});
});

test('one code bound to two buttons yields both bits', () => {
	// One pair per code rather than a Map: if such a conflict ever reaches here
	// (the normalised config refuses it, but storage or a network peer could
	// supply it anyway), both buttons must still light up rather than one of
	// them vanishing silently.
	withGamepads([{ index: 0, buttons: [0] }], () => {
		const collector = new InputCollector(
			{ keys: KEY_CONFIG, pad: { ...STANDARD_PAD, a: ['PadButton0'] } },
			ALL
		);
		assert.equal(collector.read(), (PAD.A | PAD.B), 'PadButton0 is bound to B by default and to A here');
	});
});
