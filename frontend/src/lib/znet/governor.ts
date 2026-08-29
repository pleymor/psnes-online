/**
 * Real-time driver for a TickSource.
 *
 * The session itself is timer-free on purpose; this is the only place that
 * knows about wall-clock time, which keeps the netcode testable. Its job is
 * narrow: decide how many `tick()` calls a given slice of real time deserves,
 * and never let an emulator run away from the clock.
 *
 * It works for netplay and for solo alike: both are just something that can be
 * ticked.
 */

import type { TickSource } from './session.js';

export interface GovernorOptions {
	/** Emulated frames per second. SNES NTSC is 60.0988, not 60. */
	fps?: number;
	/**
	 * Upper bound on frames executed in one scheduler slice. After a network
	 * stall the session has to catch up, but catching up without a ceiling
	 * turns a 2-second hiccup into a 2-second burst of fast-forward.
	 */
	maxCatchUp?: number;
	/** Called after a slice, with how many frames actually ran. */
	onSlice?: (framesRun: number, stalled: boolean) => void;
	/**
	 * Whether a hidden tab keeps emulating via the worker-driven timer.
	 *
	 * Defaults to true, which is what lockstep needs: a peer that stops
	 * running frames stops sending pads, and the other player freezes with
	 * it. A solo session has no peer to protect and no reason to burn a CPU
	 * core in the background, so SoloRoom passes false to let the tab
	 * genuinely pause the way requestAnimationFrame already would on its own.
	 */
	keepRunningWhenHidden?: boolean;
}

export class FrameGovernor {
	private session: TickSource;
	private fps: number;
	private maxCatchUp: number;
	private onSlice: (framesRun: number, stalled: boolean) => void;

	private running = false;
	private handle: number | null = null;
	private accumulator = 0;
	private lastTime = 0;
	/**
	 * How fast the machine runs against the wall clock. 1 is real time.
	 *
	 * Was a boolean and a hard-coded `elapsed * 4`, so four was the only speed
	 * that existed and nobody could ask for another.
	 */
	private speed = 1;

	/**
	 * Timer that keeps running when the tab is not visible.
	 *
	 * requestAnimationFrame stops outright in a hidden tab, and setTimeout is
	 * throttled to roughly once a second. Either would be fine for a solo
	 * emulator - it would simply pause - but this one is half of a lockstep
	 * pair: a peer that stops running frames stops sending pads, and the other
	 * player freezes with it. Two windows on one machine can never both be in
	 * the foreground, which is exactly how most people will try this.
	 *
	 * Timers inside a worker are not throttled, so a hidden window keeps
	 * emulating and its partner keeps playing. Solo has no partner to protect
	 * this way, so it sets keepRunningWhenHidden to false and gets the plain
	 * rAF behaviour: a hidden tab simply stops, same as before this stack
	 * existed.
	 */
	private worker: Worker | null = null;
	private keepRunningWhenHidden: boolean;
	private onVisibilityChange = () => this.reschedule();

	constructor(session: TickSource, options: GovernorOptions = {}) {
		this.session = session;
		this.fps = options.fps ?? 60.0988;
		this.maxCatchUp = options.maxCatchUp ?? 8;
		this.onSlice = options.onSlice ?? (() => {});
		this.keepRunningWhenHidden = options.keepRunningWhenHidden ?? true;
	}

	get isRunning(): boolean {
		return this.running;
	}

	/**
	 * Runs the machine at `multiplier` times real time. 1 puts it back.
	 *
	 * Only meaningful when every peer agrees, so a lockstep room never calls it
	 * - it is the solo clock this belongs to.
	 *
	 * Nothing is clamped here. `maxCatchUp` already bounds what one slice can
	 * run and the accumulator is clipped to it, so a multiplier past that
	 * quietly buys nothing; refusing it is the caller's job, where there is a
	 * field to put the refusal in front of.
	 */
	setSpeed(multiplier: number): void {
		this.speed = multiplier;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.lastTime = performance.now();
		this.accumulator = 0;
		document.addEventListener('visibilitychange', this.onVisibilityChange);
		this.schedule();
	}

	stop(): void {
		this.running = false;
		document.removeEventListener('visibilitychange', this.onVisibilityChange);
		if (this.handle !== null) {
			cancelAnimationFrame(this.handle);
			this.handle = null;
		}
		this.stopWorker();
	}

	/** Switches scheduler when the tab is hidden or shown. */
	private reschedule(): void {
		if (!this.running) return;
		if (this.handle !== null) {
			cancelAnimationFrame(this.handle);
			this.handle = null;
		}
		this.stopWorker();
		// A hidden tab has been getting no slices, so the elapsed time since the
		// last one is meaningless; start the clock fresh rather than replaying it.
		this.lastTime = performance.now();
		this.schedule();
	}

	private schedule(): void {
		if (typeof document !== 'undefined' && document.hidden && this.keepRunningWhenHidden) {
			this.startWorker();
			return;
		}
		this.handle = requestAnimationFrame(() => this.slice());
	}

	private startWorker(): void {
		if (this.worker) return;
		const source = `let t=setInterval(()=>postMessage(0),8);onmessage=()=>{clearInterval(t)}`;
		const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
		try {
			this.worker = new Worker(url);
			this.worker.onmessage = () => this.slice();
		} catch {
			// No worker available: fall back to a timer. It will be throttled in
			// a hidden tab, but a slow session beats a dead one.
			this.handle = setTimeout(() => this.slice(), 16) as unknown as number;
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	private stopWorker(): void {
		if (!this.worker) return;
		this.worker.postMessage('stop');
		this.worker.terminate();
		this.worker = null;
	}

	private slice(): void {
		if (!this.running) return;

		const now = performance.now();
		let elapsed = now - this.lastTime;
		this.lastTime = now;

		// Handshake retries and RTT probes. Cheap, and it has to keep running
		// even while the session is stalled or still syncing.
		this.session.pump();

		// A tab that was backgrounded reports a huge delta. Replaying it would
		// dump hundreds of frames into a lockstep session at once.
		if (elapsed > 250) elapsed = 250;

		const frameTime = 1000 / this.fps;
		this.accumulator += elapsed * this.speed;

		let ran = 0;
		let stalled = false;
		while (this.accumulator >= frameTime && ran < this.maxCatchUp) {
			const result = this.session.tick();
			if (result === 'ran') {
				this.accumulator -= frameTime;
				ran++;
			} else {
				// Stalled or idle: hold the accumulated time so the frame runs
				// the instant the missing pad lands, rather than being skipped.
				stalled = result === 'stalled';
				break;
			}
		}

		// Do not let unspent time pile up without bound while stalled, or the
		// session sprints once the packet arrives.
		const ceiling = frameTime * this.maxCatchUp;
		if (this.accumulator > ceiling) this.accumulator = ceiling;

		this.onSlice(ran, stalled);

		// The worker re-arms itself; only the rAF path needs a new request.
		if (!this.worker) this.schedule();
	}
}
