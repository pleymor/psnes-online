/**
 * The shared search for a controller.
 *
 * Everything here exists because of one rule that lives in the browser and not
 * in this repository: a gamepad does not exist until one of its buttons has been
 * pressed. `gamepadconnected` fires at that press and not before, so a page that
 * only listens is blind to a pad that announced itself while the page was still
 * fetching - and a page that only reads once at mount is blind to everything
 * after that instant. Hence both, and hence a poll that stops as soon as it has
 * found something.
 *
 * The watcher takes its navigator, its event target and its clock as parameters,
 * the way `invitationState` takes its instant: without that, none of the five
 * behaviours below can be observed at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createPadWatcher } from '../../frontend/src/lib/controls/pad-watch.js';

const pad = (index: number, id: string) => ({ index, id, connected: true });

/** A navigator whose pad list the test moves, plus an event target and a clock. */
function harness(initial: unknown[] = []) {
	let list = initial;
	const listeners = new Map<string, Set<() => void>>();
	const timers = new Map<number, () => void>();
	let nextTimer = 1;

	return {
		setPads(next: unknown[]) {
			list = next;
		},
		fire(event: string) {
			for (const handler of listeners.get(event) ?? []) handler();
		},
		tick() {
			for (const run of [...timers.values()]) run();
		},
		get timerCount() {
			return timers.size;
		},
		get listenerCount() {
			let n = 0;
			for (const set of listeners.values()) n += set.size;
			return n;
		},
		deps: {
			nav: { getGamepads: () => list } as unknown as Navigator,
			on(event: string, handler: () => void) {
				if (!listeners.has(event)) listeners.set(event, new Set());
				listeners.get(event)!.add(handler);
			},
			off(event: string, handler: () => void) {
				listeners.get(event)?.delete(handler);
			},
			setInterval(run: () => void) {
				const id = nextTimer++;
				timers.set(id, run);
				return id;
			},
			clearInterval(id: number) {
				timers.delete(id);
			}
		}
	};
}

test('a pad the browser already knows is reported to the first watcher', () => {
	const h = harness([pad(0, '8BitDo SN30 (Vendor: 2dc8)')]);
	const watcher = createPadWatcher(h.deps);

	const seen: unknown[] = [];
	const unsubscribe = watcher.pads.subscribe((pads) => seen.push(pads));
	const stop = watcher.watch();

	assert.deepEqual(seen.at(-1), [{ index: 0, id: '8BitDo SN30 (Vendor: 2dc8)' }]);
	stop();
	unsubscribe();
});

test('a pad that appears only later is found by the poll, with no event at all', () => {
	// The case an event listener cannot cover: the press happened while nobody
	// was listening, so `gamepadconnected` has already been and gone.
	const h = harness([]);
	const watcher = createPadWatcher(h.deps);
	const unsubscribe = watcher.pads.subscribe(() => {});
	const stop = watcher.watch();

	let current: unknown = null;
	const seen = watcher.pads.subscribe((pads) => (current = pads));
	assert.deepEqual(current, []);

	h.setPads([pad(1, 'Xbox Controller')]);
	h.tick();

	assert.deepEqual(current, [{ index: 1, id: 'Xbox Controller' }]);
	seen();
	stop();
	unsubscribe();
});

test('the poll stops once something is known, and starts again when it goes', () => {
	const h = harness([]);
	const watcher = createPadWatcher(h.deps);
	const stop = watcher.watch();

	assert.equal(h.timerCount, 1, 'searching, so polling');

	h.setPads([pad(0, 'Pad')]);
	h.tick();
	assert.equal(h.timerCount, 0, 'found, so no longer polling');

	// Unplugging is an event the browser does send, and it puts us back to
	// searching.
	h.setPads([]);
	h.fire('gamepaddisconnected');
	assert.equal(h.timerCount, 1, 'searching again');

	stop();
});

test('two watchers share one timer and one set of listeners', () => {
	const h = harness([]);
	const watcher = createPadWatcher(h.deps);

	const stopA = watcher.watch();
	const listenersWithOne = h.listenerCount;
	const stopB = watcher.watch();

	assert.equal(h.listenerCount, listenersWithOne, 'the second watcher adds no listener');
	assert.equal(h.timerCount, 1, 'and no second timer');

	// The first to leave takes nothing down: the other one is still watching.
	stopA();
	assert.equal(h.timerCount, 1);
	assert.equal(h.listenerCount, listenersWithOne);

	stopB();
});

test('the last watcher to leave takes the timer and the listeners with it', () => {
	// A timer that outlives its last watcher is what turned a 0.9s test suite
	// into a 48s one, twice, in this repository.
	const h = harness([]);
	const watcher = createPadWatcher(h.deps);

	const stop = watcher.watch();
	assert.ok(h.listenerCount > 0);
	assert.equal(h.timerCount, 1);

	stop();

	assert.equal(h.listenerCount, 0, 'no listener left behind');
	assert.equal(h.timerCount, 0, 'no timer left behind');
});

test('a navigator with no gamepad support is not an error, just no pads', () => {
	// Chrome leaves `getGamepads` undefined in a non-secure context, which the
	// capture poll already guards against.
	const h = harness([]);
	const watcher = createPadWatcher({ ...h.deps, nav: {} as Navigator });
	const stop = watcher.watch();

	let current: unknown = null;
	const seen = watcher.pads.subscribe((pads) => (current = pads));
	h.tick();

	assert.deepEqual(current, []);
	seen();
	stop();
});
