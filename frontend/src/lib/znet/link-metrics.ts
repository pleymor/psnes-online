/**
 * What the link is doing, measured. Decides nothing.
 *
 * Extracted from NetplaySession so that the numbers the delay loop reacts to
 * can be exercised without driving a whole session: a loop whose input is only
 * reachable through ten seconds of simulated network cannot be told apart from
 * a loop that is broken.
 *
 * Every method takes the current time as a parameter rather than reading a
 * clock, for the same reason the session does: the tests drive entire sessions
 * through a virtual clock at full CPU speed.
 */

import { FrameTimes } from './host-health.js';

/** Window over which late frames are counted, and reported to the peer. */
const STRAIN_WINDOW = 128;

/**
 * A frame gap this much wider than the machine's own is a stutter a player
 * sees. The same threshold the offline instrument uses, so the two agree.
 */
const LATE_FACTOR = 1.5;

/**
 * Arrivals kept for the gap and clump peaks. About 1.2s at 52 packets a second.
 *
 * Long enough that a single excursion is still visible when the telemetry is
 * sampled once a second, short enough that a peak from ten seconds ago is not
 * still being reported as if it were now.
 */
const ARRIVAL_WINDOW = 64;



export class LinkMetrics {
	private fps: number;

	private pendingPings = new Map<number, number>();
	private _rtt: number | null = null;

	/**
	 * Interarrival jitter over the pad stream, the way RFC 3550 computes it for
	 * RTP: the running mean of how far each packet's spacing departs from the
	 * spacing it was sent with.
	 *
	 * Pad packets are the right carrier for it. The peer emits one per frame it
	 * executes, so they sample the path sixty times a second and they each name
	 * the frame they belong to - which gives the intended spacing for free, with
	 * no clock to synchronise. Deriving it from the ping instead would sample
	 * once every two seconds and say nothing about variation at frame scale.
	 */
	private _jitter: number | null = null;
	/** Arrival time and newest frame of the last pad packet that advanced. */
	private lastPadArrival: { at: number; frame: number } | null = null;

	/**
	 * "Was this frame late", as a ring over the last window, with its sum.
	 *
	 * A ring rather than a running total, because the figure has to *fall* again
	 * once a rough patch passes. A total would keep an old outage on the books
	 * for the rest of the session and hold the delay up with it.
	 */
	private lateRing = new Uint8Array(STRAIN_WINDOW);
	private lateAt = 0;
	private lateCount = 0;
	private lastFrameAt: number | null = null;

	/**
	 * The same window, for the frames that were late while we were *not*
	 * waiting on the peer.
	 *
	 * `strain` drops these on purpose - no delay the peer chooses can mend a
	 * machine that paces badly, so sending them would walk the partner's delay
	 * up for nothing. But dropping them also threw away the answer to the
	 * question every bad evening opens with: the network, or this machine?
	 * Kept in their own ring the two read side by side, and a session where one
	 * peer stutters on a link the other finds calm stops being a mystery.
	 *
	 * Diagnostic only. Nothing decides anything from this.
	 */
	private localLateRing = new Uint8Array(STRAIN_WINDOW);
	private localLateCount = 0;

	/**
	 * How often this machine can actually present a frame, measured.
	 *
	 * A frame is not late because it missed the cadence the *cartridge* asks
	 * for; it is late because the machine failed to keep up with the cadence it
	 * can present at. The two differ whenever the display is not a multiple of
	 * the game: a 50Hz PAL game on a 60Hz screen can only be shown every
	 * 16.67ms, so four frames in five sit one slot apart and the fifth sits two,
	 * at 33.3ms. That beat is the correct cadence for those two clocks.
	 *
	 * Derived from the emulated frame alone, the threshold was 20 x 1.5 = 30ms,
	 * which the 33.3ms beat clears by 11%. Every PAL session on a 60Hz screen
	 * therefore reported one frame in five late - 22 to 26 per 128 on a real
	 * phone, against 25.6 predicted, falling to 0 on the same hardware with an
	 * NTSC cartridge.
	 *
	 * So the quantum is measured rather than assumed: the shortest real gap of
	 * the previous window. `pending` gathers the current one and they swap when
	 * the ring wraps, which costs one comparison a frame and no allocation.
	 * Zero means not yet known, and until it is the emulated frame is used -
	 * the behaviour this had before, which is the safe way to be wrong.
	 */
	/**
	 * The shape of this machine's frame intervals, and the period it presents at.
	 *
	 * Delegated rather than kept here: solo has no peer, no link and no metrics,
	 * yet it is the mode where a slowdown can be isolated without a network in
	 * the way. Writing the same arithmetic in both places is how two copies
	 * drift apart in silence.
	 */
	private frameTimes = new FrameTimes(STRAIN_WINDOW);

	/**
	 * How the peer's pads actually turn up, as two peaks rather than an average.
	 *
	 * `jitter` above is an average, and averages are why this exists. Measured
	 * across a real session it read 2.0ms while the link was calm and 2.1ms
	 * while it was loaded and the round-trip p90 had risen 42% - RFC 3550's
	 * gain-of-1/16 smoothing is built to ignore precisely the excursion that
	 * empties a lockstep buffer. A peak that has to survive being averaged with
	 * sixty quiet neighbours does not survive.
	 *
	 * So: the longest silence between two deliveries, and the largest number of
	 * frames a single delivery carried. Even one-per-frame delivery reads as a
	 * gap of one frame and a clump of one. A relay that batches reads as either
	 * a long gap followed by several packets at once, or a long gap followed by
	 * one packet carrying the whole run - the two shapes the same cause takes,
	 * which is why both numbers are needed to tell them apart.
	 */
	private gapRing = new Float64Array(ARRIVAL_WINDOW);
	private clumpRing = new Uint8Array(ARRIVAL_WINDOW);
	private arrivalAt = 0;

	/** The last strain the peer reported, kept for the diagnostics. */
	private _peerStrain = 0;

	constructor(fps: number) {
		this.fps = fps;
	}

	get rtt(): number | null {
		return this._rtt;
	}
	get jitter(): number | null {
		return this._jitter;
	}
	/**
	 * Late frames over the last 128 that we spent waiting on the peer. Zero is
	 * the healthy figure.
	 */
	get strain(): number {
		return this.lateCount;
	}
	get peerStrain(): number {
		return this._peerStrain;
	}
	/**
	 * Late frames over the last 128 that were nothing to do with the peer.
	 * Read against `strain`: the network is the other one.
	 */
	get localStrain(): number {
		return this.localLateCount;
	}
	/**
	 * How long frames actually took, as a shape rather than an average.
	 *
	 * Read against each other: a median at the cartridge's frame time with a
	 * heavy tail is a machine that stutters in bursts, which is what a player
	 * notices and what `fps` hides.
	 */
	get frameMs50(): number {
		return this.frameTimes.ms50;
	}
	get frameMs95(): number {
		return this.frameTimes.ms95;
	}
	get frameMsMax(): number {
		return this.frameTimes.msMax;
	}

	/** Longest silence between two deliveries in the window, in ms. */
	get arrivalGap(): number {
		let worst = 0;
		for (const gap of this.gapRing) if (gap > worst) worst = gap;
		return worst;
	}

	/** Most frames a single delivery carried in the window. */
	get arrivalClump(): number {
		let worst = 0;
		for (const clump of this.clumpRing) if (clump > worst) worst = clump;
		return worst;
	}

	notePingSent(id: number, at: number): void {
		this.pendingPings.set(id, at);
	}

	/**
	 * The raw round trip for `id`, or null if it was never sent or already
	 * answered.
	 *
	 * `rtt` itself is lightly smoothed - gain 0.3 - so a single outlier does
	 * not move the number shown, but a real route change still shows up. The
	 * caller gets the raw sample back because the delay-sizing burst wants the
	 * spread across samples, which an average has already thrown away.
	 */
	notePingReply(id: number, at: number): number | null {
		const sentAt = this.pendingPings.get(id);
		if (sentAt === undefined) return null;
		this.pendingPings.delete(id);
		const sample = at - sentAt;
		this._rtt = this._rtt === null ? sample : this._rtt * 0.7 + sample * 0.3;
		return sample;
	}

	/**
	 * Notes when the peer's newest pad arrived, and updates the jitter estimate.
	 *
	 * Jitter, not latency, is the number that decides the input delay: latency
	 * costs a one-off offset between the peers, while it is the *variation* that
	 * leaves a pad late for the frame that needed it.
	 *
	 * Only packets whose newest frame has advanced count. Every pad packet
	 * repeats the last few frames the sender already transmitted, and the
	 * session re-sends the whole reachable range while stalled, so a great many
	 * arrivals carry nothing new - timing those would measure the re-send
	 * policy rather than the link.
	 */
	samplePadArrival(newestFrame: number, at: number): void {
		const previous = this.lastPadArrival;
		if (previous === null || newestFrame <= previous.frame) {
			if (previous === null) this.lastPadArrival = { at, frame: newestFrame };
			return;
		}
		// What the spacing should have been: the sender emits one packet per
		// frame it runs, so the frames between the two packets are the gap.
		const expected = ((newestFrame - previous.frame) * 1000) / this.fps;
		const drift = Math.abs(at - previous.at - expected);
		// RFC 3550's smoothing, gain 1/16: slow enough that one reordered packet
		// does not move the figure, quick enough to follow a route that changes.
		this._jitter = this._jitter === null ? drift : this._jitter + (drift - this._jitter) / 16;

		// The same two facts, kept unsmoothed. See `gapRing` above for why.
		this.gapRing[this.arrivalAt] = at - previous.at;
		this.clumpRing[this.arrivalAt] = Math.min(255, newestFrame - previous.frame);
		this.arrivalAt = (this.arrivalAt + 1) % ARRIVAL_WINDOW;

		this.lastPadArrival = { at, frame: newestFrame };
	}

	/**
	 * Notes whether the frame about to run is arriving late, and whether the
	 * peer is why.
	 *
	 * `waitedOnPeer` is the whole of the difference between a number worth
	 * shipping and one that misleads. A gap wider than the machine's own frame
	 * has two possible causes, and only one of them is the partner's to fix: a
	 * pad that had not arrived, or this machine simply not holding cadence.
	 * Counting both put a host that ran its emulator in bursts at a permanent
	 * strain of 25 while its stall counter never moved, and its partner - which
	 * reads the number as "raise your delay, you are starving me" - walked
	 * itself to MAX_INPUT_DELAY over a stutter no delay could have touched.
	 *
	 * So local lateness is dropped here rather than second-guessed by the loop
	 * downstream. What survives is exactly what the partner's input delay can
	 * mend, which is what the figure claims to be.
	 */
	noteFrameRun(at: number, waitedOnPeer: boolean): void {
		const previous = this.lastFrameAt;
		this.lastFrameAt = at;
		if (previous === null) return;
		const gap = at - previous;
		this.frameTimes.note(gap);

		/*
		 * What this frame was entitled to take: the emulated frame rounded up to
		 * whole presentation slots, when the machine presents faster than the
		 * game asks. `LATE_FACTOR` then applies to that, which is what it always
		 * meant - a gap this much wider than the machine's own cadence.
		 */
		const frameMs = 1000 / this.fps;
		const quantum = this.frameTimes.quantum;
		const expected =
			quantum > 0 && quantum < frameMs ? Math.ceil(frameMs / quantum) * quantum : frameMs;

		const over = gap > expected * LATE_FACTOR;
		const late = over && waitedOnPeer ? 1 : 0;
		const localLate = over && !waitedOnPeer ? 1 : 0;
		this.lateCount += late - this.lateRing[this.lateAt];
		this.lateRing[this.lateAt] = late;
		this.localLateCount += localLate - this.localLateRing[this.lateAt];
		this.localLateRing[this.lateAt] = localLate;
		// One cursor for both rings: every frame writes exactly one slot in
		// each, so they age together and a single index cannot drift.
		this.lateAt = (this.lateAt + 1) % STRAIN_WINDOW;
	}

	notePeerStrain(strain: number): void {
		this._peerStrain = strain;
	}

	/**
	 * Forgets everything timed against the abandoned timeline: frame numbers
	 * mean something different on a new one, so the spacing measured across the
	 * seam would be nonsense, and a resync's own gap is not strain.
	 */
	resetFrameTiming(): void {
		this.lastPadArrival = null;
		this.lastFrameAt = null;
		this.gapRing.fill(0);
		this.clumpRing.fill(0);
		this.arrivalAt = 0;
		this.lateRing.fill(0);
		this.lateCount = 0;
		this.lateAt = 0;
		this.localLateRing.fill(0);
		this.localLateCount = 0;
		this.frameTimes.reset();
	}
}
