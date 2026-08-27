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

/** Window over which late frames are counted, and reported to the peer. */
const STRAIN_WINDOW = 128;

/**
 * A frame gap this much wider than the machine's own is a stutter a player
 * sees. The same threshold the offline instrument uses, so the two agree.
 */
const LATE_FACTOR = 1.5;

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
		const late = waitedOnPeer && at - previous > (1000 / this.fps) * LATE_FACTOR ? 1 : 0;
		this.lateCount += late - this.lateRing[this.lateAt];
		this.lateRing[this.lateAt] = late;
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
		this.lateRing.fill(0);
		this.lateCount = 0;
		this.lateAt = 0;
	}
}
