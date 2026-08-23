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
import { STANDARD_PAD } from '../../frontend/src/lib/controls/binding.js';

const KEY_CONFIG = {
	up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
	a: 'KeyX', b: 'KeyZ', x: 'KeyS', y: 'KeyA',
	l: 'KeyQ', r: 'KeyW', start: 'Enter', select: 'ShiftRight'
};

/** Le joueur par défaut : ce clavier, et le mappage manette standard. */
const CONTROLS = { keys: KEY_CONFIG, pad: STANDARD_PAD };

/** Tout écouter, ce que fait un joueur seul. */
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

/** Installe de faux pads sur globalThis.navigator le temps de `fn`. */
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

test("tout écouter reste le défaut d'un joueur seul", () => {
	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(CONTROLS, ALL);
		assert.equal(collector.read(), PAD.A, 'le bouton 1 est A dans le mappage standard');
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

test('les sources changent en cours de route', () => {
	withGamepads([{ index: 0, buttons: [1] }, { index: 2, buttons: [] }], () => {
		const collector = new InputCollector(CONTROLS, ALL);
		assert.equal(collector.read(), PAD.A);

		collector.setSources({ keyboard: true, pads: [] });
		assert.equal(collector.read(), 0);

		collector.setSources({ keyboard: true, pads: [2] });
		assert.equal(collector.read(), 0, 'le pad 2 n’a rien d’enfoncé');

		collector.setSources({ keyboard: true, pads: [0] });
		assert.equal(collector.read(), PAD.A);
	});
});

test('a missing gamepad API is not an error', () => {
	// node has none, and neither do some locked-down browser contexts.
	const collector = new InputCollector(CONTROLS, ALL);
	assert.equal(collector.read(), 0);
});

/* --------------------------------------------- la config manette est lue */

test('le mappage standard donne les mêmes bits que la table en dur qu’il remplace', () => {
	// Le test anti-régression du morceau : l'ancienne lecture était une table
	// codée en dur que la config ne pouvait pas influencer.
	const expected: Array<[number, number]> = [
		[0, PAD.B], [1, PAD.A], [2, PAD.Y], [3, PAD.X],
		[4, PAD.L], [5, PAD.R], [8, PAD.SELECT], [9, PAD.START],
		[12, PAD.UP], [13, PAD.DOWN], [14, PAD.LEFT], [15, PAD.RIGHT]
	];

	for (const [button, bit] of expected) {
		withGamepads([{ index: 0, buttons: [button] }], () => {
			const collector = new InputCollector(CONTROLS, ALL);
			assert.equal(collector.read(), bit, `le bouton ${button} doit donner ${bit}`);
		});
	}
});

test('le stick gauche fait toujours la croix', () => {
	// Il la faisait par une règle en dur. Il la fait maintenant par deux codes
	// PadAxis du mappage standard, et il doit la faire pareil.
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

test('une liaison manette réassignée prend effet', () => {
	withGamepads([{ index: 0, buttons: [7] }], () => {
		const collector = new InputCollector(
			{ keys: KEY_CONFIG, pad: { ...STANDARD_PAD, a: ['PadButton7'] } },
			ALL
		);
		assert.equal(collector.read(), PAD.A, 'le bouton 7 est devenu A');
	});

	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(
			{ keys: KEY_CONFIG, pad: { ...STANDARD_PAD, a: ['PadButton7'] } },
			ALL
		);
		assert.equal(collector.read(), 0, 'et le bouton 1 ne l’est plus');
	});
});

test('un emplacement manette vidé ne répond à rien', () => {
	withGamepads([{ index: 0, buttons: [1] }], () => {
		const collector = new InputCollector(
			{ keys: KEY_CONFIG, pad: { ...STANDARD_PAD, a: [] } },
			ALL
		);
		assert.equal(collector.read(), 0);
	});
});

test('un joueur sans clavier ignore les touches', () => {
	const win = fakeWindow();
	withoutGamepads(() => {
		const collector = new InputCollector(CONTROLS, { keyboard: false, pads: [] });
		collector.attach(win as never);

		let prevented = false;
		win.fire('keydown', { code: 'KeyX', preventDefault: () => { prevented = true; } });
		assert.equal(collector.read(), 0, 'le clavier du J1 ne doit pas atteindre le J2');
		assert.equal(prevented, false, 'un joueur sans clavier ne doit pas voler la touche à la page');

		collector.detach(win as never);
	});
});

test('couper le clavier relâche ce qui était tenu', () => {
	const win = fakeWindow();
	withoutGamepads(() => {
		const collector = new InputCollector(CONTROLS, ALL);
		collector.attach(win as never);
		win.fire('keydown', { code: 'ArrowUp' });
		assert.equal(collector.read(), PAD.UP);

		collector.setSources({ keyboard: false, pads: 'all' });
		assert.equal(collector.read(), 0, 'sinon la direction reste bloquée pour toujours');

		// La touche est toujours tenue en interne à ce stade : ce n'est que
		// parce que `read()` ignore le clavier que le masque précédent valait
		// 0. Rallumer le clavier sans avoir vidé `held` referait apparaître
		// UP tout seul, alors que rien n'a été réappuyé.
		collector.setSources({ keyboard: true, pads: 'all' });
		assert.equal(collector.read(), 0, 'sans le vidage, UP resterait bloqué après le retour du clavier');

		collector.detach(win as never);
	});
});

test('deux joueurs sur deux pads ne se croisent pas', () => {
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

test('deux boutons enfoncés en même temps donnent leurs deux bits', () => {
	withGamepads([{ index: 0, buttons: [1, 9] }], () => {
		const collector = new InputCollector(CONTROLS, { keyboard: false, pads: [0] });
		assert.equal(collector.read(), PAD.A | PAD.START);
	});
});

test('sanitise() s’applique aussi au masque venu de la manette', () => {
	// STANDARD_PAD lie chaque direction à la fois à un bouton et à un axe : le
	// bouton 14 est LEFT, et le stick poussé à droite est aussi RIGHT. Une
	// vraie manette rapporte les deux si le d-pad et le stick se contredisent,
	// et sanitise() doit trancher pour ce masque-là exactement comme pour le
	// clavier.
	withGamepads([{ index: 0, buttons: [14], axes: [1, 0] }], () => {
		const collector = new InputCollector(CONTROLS, ALL);
		const mask = collector.read();
		assert.notEqual(mask & PAD.LEFT, 0, 'le bouton d-pad doit compter');
		assert.equal(mask & PAD.RIGHT, 0, 'la seconde direction opposée doit être coupée');
	});
});

test('un même code lié à deux boutons donne les deux bits', () => {
	// Une paire par code plutôt qu'une Map : si jamais un tel conflit arrive
	// jusqu'ici (la config normalisée le refuse, mais un stockage ou un pair
	// réseau pourrait le fournir quand même), les deux boutons doivent quand
	// même s'allumer plutôt que l'un d'eux disparaître silencieusement.
	withGamepads([{ index: 0, buttons: [0] }], () => {
		const collector = new InputCollector(
			{ keys: KEY_CONFIG, pad: { ...STANDARD_PAD, a: ['PadButton0'] } },
			ALL
		);
		assert.equal(collector.read(), (PAD.A | PAD.B), 'PadButton0 est lié à B par défaut et à A ici');
	});
});
