/**
 * Looking for a controller, for as long as somebody is looking.
 *
 * The rule this is built around lives in the browser, not here: **a gamepad does
 * not exist until one of its buttons has been pressed.** `getGamepads()` returns
 * holes until then, and `gamepadconnected` fires at that press and never again.
 *
 * Two consequences, and both are the reason this module is not just an event
 * listener. A screen that only listens is blind to a pad that announced itself
 * while the screen was still fetching something - which is exactly the profile
 * page, whose controls card waits for `/api/user/controls` before it mounts
 * anything. And a screen that only reads once at mount is blind to everything
 * after that instant. So: the events *and* a poll, and the poll stops as soon as
 * it has found something, because from then on `gamepaddisconnected` is enough.
 *
 * What this does *not* do is assign anything. Player 1 defaults to `'auto'` -
 * the keyboard plus every free pad - so a pad that appears is already playable;
 * assigning it explicitly would write `keyboard: false` and cut the keyboard off
 * because somebody brushed a controller on a settings page.
 */
import { readable, type Readable } from 'svelte/store';
// Relative, not `$lib`: `core/test` imports this module straight into node,
// where the alias does not resolve. `znet/input.ts` reaches `controls/binding`
// the same way, for the same reason.
import { connectedPads, type PadInfo } from '../znet/devices.js';

/** How often to look while nothing has been found. Slow: nobody is playing yet. */
export const PAD_SEARCH_INTERVAL_MS = 400;

export interface PadWatcherDeps {
	nav: Navigator | undefined;
	on(event: string, handler: () => void): void;
	off(event: string, handler: () => void): void;
	setInterval(run: () => void, ms: number): number;
	clearInterval(id: number): void;
}

export interface PadWatcher {
	/** The pads the browser admits to, kept current while anyone is watching. */
	pads: Readable<PadInfo[]>;
	/** Starts watching. The returned function is this watcher's own stop. */
	watch(): () => void;
}

function samePads(a: PadInfo[], b: PadInfo[]): boolean {
	return a.length === b.length && a.every((pad, i) => pad.index === b[i].index && pad.id === b[i].id);
}

/**
 * A watcher over injected dependencies.
 *
 * The navigator, the event target and the clock are parameters for the same
 * reason `invitationState` takes its instant: without them none of this can be
 * observed by a test, and what has to be proved here is precisely the timer's
 * life - a timer that outlives its last watcher has twice turned this
 * repository's test suite from 0.9 seconds into 48.
 */
export function createPadWatcher(deps: PadWatcherDeps): PadWatcher {
	let current: PadInfo[] = [];
	let publish: (value: PadInfo[]) => void = () => {};
	let watchers = 0;
	let timer: number | null = null;

	const pads = readable<PadInfo[]>([], (set) => {
		publish = set;
		set(current);
		return () => {
			publish = () => {};
		};
	});

	function look() {
		const found = connectedPads(deps.nav);
		// Compared rather than set unconditionally: this runs several times a
		// second while searching, and `pads` feeds a `$:` chain that resolves
		// every input source.
		if (!samePads(found, current)) {
			current = found;
			publish(current);
		}
		// Found something, so stop looking. Losing it starts this again, through
		// the disconnect event below.
		if (current.length > 0) stopPolling();
		else startPolling();
	}

	function startPolling() {
		if (timer !== null || watchers === 0) return;
		timer = deps.setInterval(look, PAD_SEARCH_INTERVAL_MS);
	}

	function stopPolling() {
		if (timer === null) return;
		deps.clearInterval(timer);
		timer = null;
	}

	function watch(): () => void {
		watchers += 1;
		if (watchers === 1) {
			deps.on('gamepadconnected', look);
			deps.on('gamepaddisconnected', look);
		}
		look();

		let stopped = false;
		return () => {
			// Guarded: a component that calls its own stop twice must not take the
			// watch away from somebody else.
			if (stopped) return;
			stopped = true;
			watchers -= 1;
			if (watchers > 0) return;

			stopPolling();
			deps.off('gamepadconnected', look);
			deps.off('gamepaddisconnected', look);
		};
	}

	return { pads, watch };
}

/**
 * The one watcher the application shares.
 *
 * Built against the real window so that the two screens that look for a pad -
 * the profile page and the pause panel's controls - share one timer and one pair
 * of listeners however they overlap.
 */
const shared = createPadWatcher({
	nav: typeof navigator === 'undefined' ? undefined : navigator,
	on: (event, handler) => globalThis.addEventListener?.(event, handler),
	off: (event, handler) => globalThis.removeEventListener?.(event, handler),
	setInterval: (run, ms) => setInterval(run, ms) as unknown as number,
	clearInterval: (id) => clearInterval(id)
});

export const pads = shared.pads;
export const watchPads = shared.watch;
