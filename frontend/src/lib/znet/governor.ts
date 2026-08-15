/**
 * Real-time driver for a NetplaySession.
 *
 * The session itself is timer-free on purpose; this is the only place that
 * knows about wall-clock time, which keeps the netcode testable. Its job is
 * narrow: decide how many `tick()` calls a given slice of real time deserves,
 * and never let an emulator run away from the clock.
 */

import type { NetplaySession } from './session.js';

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
}

export class FrameGovernor {
	private session: NetplaySession;
	private fps: number;
	private maxCatchUp: number;
	private onSlice: (framesRun: number, stalled: boolean) => void;

	private running = false;
	private handle: number | null = null;
	private accumulator = 0;
	private lastTime = 0;
	private turbo = false;

	constructor(session: NetplaySession, options: GovernorOptions = {}) {
		this.session = session;
		this.fps = options.fps ?? 60.0988;
		this.maxCatchUp = options.maxCatchUp ?? 8;
		this.onSlice = options.onSlice ?? (() => {});
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** Fast-forward. Only meaningful when every peer agrees, so it is off by default. */
	setTurbo(on: boolean): void {
		this.turbo = on;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.lastTime = performance.now();
		this.accumulator = 0;
		this.schedule();
	}

	stop(): void {
		this.running = false;
		if (this.handle !== null) {
			cancelAnimationFrame(this.handle);
			this.handle = null;
		}
	}

	private schedule(): void {
		this.handle = requestAnimationFrame(() => this.slice());
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
		this.accumulator += this.turbo ? elapsed * 4 : elapsed;

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
		this.schedule();
	}
}
