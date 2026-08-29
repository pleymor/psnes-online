/**
 * The input-delay policy, and nothing else.
 *
 * Decides; never applies. Raising the delay leaves a hole in the pad timeline
 * that has to be filled and reshipped, which needs the timeline and the
 * transport - so the session keeps `setDelay` and this returns a verdict.
 *
 * Two mechanisms live here. The handshake sizes the delay once from a burst of
 * round trips, and thereafter a slow loop walks it up when the peer reports
 * losing frames and back down when the link has been quiet for a full window.
 */

/**
 * Floor for the *estimate*, which is a guess and has to be a cautious one.
 *
 * It comes from five pings over 300ms, and that burst under-reads this relay:
 * one session measured 66ms while sizing and then ran at a median of 81ms.
 * Being a frame too tight costs the *other* player stutter, so the handshake
 * starts no lower than three whatever it thinks it saw. The loop may go lower
 * than this, but only on evidence - see MIN_AUTO_DELAY.
 */
export const MIN_INPUT_DELAY = 3;

/**
 * Floor for where the loop may *walk* the delay, which is a measurement.
 *
 * Two frames is reachable and correct on a good link: a real pair on a 52ms
 * relay path played at two each with strain at zero on both sides, and their
 * own verdict was that it was the best the game had felt. Thirty consecutive
 * seconds without a single late frame is a far better reason to sit at two than
 * a handshake's opinion, and if it turns out wrong the loop takes the frame back
 * within ten strained seconds.
 */
export const MIN_AUTO_DELAY = 2;

/**
 * Floor for a delay someone set on purpose.
 *
 * Because the requirement is on the sum, a peer can sit well under the
 * automatic floor as long as its partner sits above: on a 90ms round trip a
 * 1/5 split runs with exactly as few stalls as 3/3 and the player on the short
 * end feels 17ms instead of 50. Zero is not offered - with no lead at all every
 * frame waits a full one-way trip.
 */
export const MIN_MANUAL_DELAY = 1;

/** Hard ceiling. Past sixteen frames the game is unplayable anyway. */
export const MAX_INPUT_DELAY = 16;

/** SNES NTSC, used when the caller does not say what the machine runs at. */
export const DEFAULT_FPS = 60.0988;

/**
 * Late frames per window at which the peer is judged to be in trouble.
 *
 * Zero is the healthy figure, including for the follower: measured against a
 * deliberately generous split, the follower lost no frames at all while its
 * stalled-tick count ran into the thousands. A tight split cost 250 late frames
 * in twenty seconds, which is about 27 per window - so this sits well clear of
 * both.
 */
const STRAIN_AT = 6;

/** Sliding window, in seconds, over which strained seconds are counted. */
const STRAIN_WINDOW_SECONDS = 30;

/**
 * Strained seconds inside that window before a peer adds a frame.
 *
 * Counted in seconds rather than in packets, which is what an earlier version
 * did and got wrong. Packets arrive fifty times a second, so a single
 * three-second burst supplied more than a hundred consecutive hungry ones and
 * tripped the loop by itself - and the frame it cost was permanent. Measured on
 * a real link, strain sat at zero for 96% of a session and spiked on two to four
 * isolated seconds: exactly the shape that must *not* buy a frame.
 *
 * A third of the window is the bar. One burst marks about five seconds, because
 * strain is itself a 128-frame sliding window whose tail outlasts the burst; two
 * bursts in the same half-minute clear ten and earn the frame.
 */
export const DEFAULT_HUNGER_SECONDS = 10;

/** Round-trip samples the host collects before sizing the input delay. */
export const SIZING_SAMPLES = 5;
/** Gap between the pings of the sizing burst, in ms. */
export const SIZING_PING_GAP_MS = 60;
/** How long the host waits for the burst before sizing on what it has. */
export const SIZING_BUDGET_MS = 700;

/**
 * Frames of input delay for a set of round-trip samples.
 *
 * The question is "how long does a pad packet realistically take to arrive",
 * not "what was the average round trip". So the estimate works from the
 * fastest sample plus the spread around it - the pessimistic trip - and adds
 * one frame of slack. The old formula used a single sample and a flat
 * two-frame margin, which overpaid on a clean link and underpaid on a
 * jittery one.
 *
 * The single worst sample is discarded before the spread is measured. A
 * session's first round trip carries the socket, the TLS session and the
 * relay's route cache all waking up; it reads far above the link and never
 * repeats. Two slow samples, though, are a slow link, and those still count.
 */
export interface SizingOptions {
	/**
	 * Lowest value the result may take. Defaults to MIN_INPUT_DELAY, which is
	 * the cautious floor a handshake guess deserves; a caller sizing from a
	 * link it has been measuring for a while may pass `autoFloor`.
	 */
	floor?: number;
	/**
	 * Frames of slack on top of the trip. Defaults to two.
	 *
	 * Two is what a TCP relay costs: pads arrive in clumps rather than one per
	 * frame, and the margin is the buffer that absorbs a clump. An unordered
	 * SCTP channel does not clump - that is why it was chosen - so a caller on
	 * the direct path may ask for less and stop paying for a problem it does
	 * not have.
	 */
	margin?: number;
}

export function suggestInputDelay(
	samples: number[] | number,
	fps = DEFAULT_FPS,
	options: SizingOptions = {}
): number {
	const floor = options.floor ?? MIN_INPUT_DELAY;
	const all = typeof samples === 'number' ? [samples] : samples;
	if (all.length === 0) return floor;
	const sorted = [...all].sort((a, b) => a - b);
	const considered = sorted.length >= 3 ? sorted.slice(0, -1) : sorted;
	const best = considered[0];
	const spread = considered[considered.length - 1] - best;
	const frameMs = 1000 / fps;
	/*
	 * Two frames of margin at minimum, and the measured spread on top when it
	 * asks for more.
	 *
	 * The spread was tried as a replacement for the flat two frames and that was
	 * wrong in production: it is measured over a 300ms burst during the
	 * handshake, and it cannot see how the relay actually delivers under play.
	 * A real session sized this way held 0 to 2 frames of the peer's pads and
	 * stalled twenty-four times a second - the same "50fps, stalling on almost
	 * every frame" the flat margin had been introduced to cure. Pads do not
	 * arrive one per frame down a TCP relay; they arrive in clumps, and the
	 * margin is the buffer that absorbs a clump.
	 */
	const margin = Math.max(options.margin ?? 2, Math.ceil(spread / 2 / frameMs));
	const needed = Math.ceil(best / 2 / frameMs) + margin;
	return Math.max(floor, Math.min(MAX_INPUT_DELAY, needed));
}

/**
 * The lowest delay the loop may walk to on a link this short.
 *
 * MIN_AUTO_DELAY was two because two was what a 52ms relay path measured. That
 * is a fact about a link, not a constant of the engine, and writing it down as
 * one put a floor under every session including the ones three times shorter -
 * a direct channel at 19ms was held at two frames it did not need.
 *
 * The rule is the frame, not a millisecond: one way has to fit inside one
 * frame. A PAL machine's frame is 20ms against NTSC's 16.6, so the same trip
 * can be worth one frame there and two here, and nothing in this may assume
 * 60Hz.
 *
 * Only ever one or two. Walking below one is not a trade, it is a session with
 * no lead at all, where every frame waits a full one-way trip.
 */
export function autoFloor(rttMs: number, fps = DEFAULT_FPS): number {
	const frameMs = 1000 / fps;
	return rttMs / 2 < frameMs ? MIN_MANUAL_DELAY : MIN_AUTO_DELAY;
}

/** A frame to add or give back, with the wording the session reports. */
export type DelayVerdict = { delta: -1 | 1; reason: string } | null;

export class DelayController {
	private fps: number;
	private hungerSeconds: number;
	private _automatic: boolean;

	/**
	 * Which of the last thirty seconds the peer reported strain in, and how many.
	 *
	 * A ring of one-second buckets rather than a count of packets: what matters
	 * is how much of the recent past was rough, not how many packets happened to
	 * land inside one rough moment.
	 */
	private strainedRing = new Uint8Array(STRAIN_WINDOW_SECONDS);
	/** Bucket for the second in progress, or -1 before the first one. */
	private strainedAt = -1;
	private strainedSecond = 0;
	private strainedCount = 0;
	/** Seconds observed since the window was last reset, so "a full window" means it. */
	private observedSeconds = 0;

	/** Raw round-trip samples gathered during the sizing burst. */
	private _sizingSamples: number[] = [];
	/** Pings the sizing burst has sent so far. */
	private _sizingPings = 0;

	constructor(opts: { fps: number; hungerSeconds: number; automatic: boolean }) {
		this.fps = opts.fps;
		this.hungerSeconds = opts.hungerSeconds;
		this._automatic = opts.automatic;
	}

	get automatic(): boolean {
		return this._automatic;
	}

	/** An escape hatch that moves by itself is not one. */
	pin(): void {
		this._automatic = false;
	}

	/**
	 * Hands the delay back to the loop from wherever it currently sits.
	 *
	 * Does not re-run the handshake sizing: that measurement is long gone, and
	 * it under-reads this relay anyway. The evidence starts fresh, so what the
	 * link did while nobody was acting on it does not spend a frame the instant
	 * control returns.
	 */
	resumeAutomatic(): void {
		if (this._automatic) return;
		this._automatic = true;
		this.resetWindow();
	}

	resetWindow(): void {
		this.strainedRing.fill(0);
		this.strainedCount = 0;
		this.observedSeconds = 0;
	}

	/**
	 * Discards the wall-clock reference point the window uses to measure
	 * elapsed time, so the next call starts counting from scratch instead of
	 * computing a gap across whatever just happened.
	 *
	 * Called alongside `resetWindow()` when a resync abandons the timeline.
	 * Without it, the next strain report would see a large elapsed time (no
	 * reports reach this class while the session isn't 'running') and credit
	 * that whole gap toward the clean window - crediting time when nothing was
	 * actually being observed as if it were thirty quiet seconds. `resetWindow`
	 * itself must not do this: it also runs when a frame is granted or given
	 * back mid-window, and losing the wall-clock reference there would let a
	 * short real gap immediately after look like a fresh, unelapsed window
	 * instead of continuing to accumulate it.
	 */
	resetElapsedOrigin(): void {
		this.strainedAt = -1;
	}

	/**
	 * Adds a frame of delay when the peer says it is losing frames, and gives
	 * one back when the link has been quiet for a whole window.
	 *
	 * Raising is the one adjustment the side that needs it cannot make: what
	 * keeps a peer's frames on time is *our* input delay arriving early enough,
	 * and nothing the peer controls itself. So it reports, and we act. Lowering
	 * did not always exist - a frame too generous costs 17 to 20ms of latency, a
	 * frame too tight costs the other player several stutters a second, and
	 * that asymmetry made "never lower" look like the safe choice. It was not:
	 * a real link had a bad patch, the loop paid frames for it, the link
	 * recovered and the frames stayed - eight of them, 160ms, on a link that
	 * had gone back to needing four. Every frame held past its usefulness is
	 * latency the player feels on every button press.
	 *
	 * Coming down is safe only because there is a signal worth trusting. Two
	 * earlier attempts lowered on `stats.stalls` and on buffer depth, and both
	 * read the follower's ordinary position as distress. "No strained second in
	 * thirty" says something real: not one frame arrived late in the whole
	 * window. A third attempt refused to descend below any value that had ever
	 * strained, which sounds prudent and instead froze the delay at its
	 * high-water mark for the rest of the session.
	 *
	 * The asymmetry is the whole of the hysteresis - thirty clean seconds to
	 * give a frame back against ten strained ones to take it - so the loop is
	 * quick to protect the other player and slow to reclaim latency for this
	 * one. A link sitting exactly on a frame boundary will cycle between two
	 * values on a timescale of tens of seconds; that is tolerable precisely
	 * because it means the delay is already within one frame of right.
	 *
	 * A hand-pinned delay is left alone, exactly as the handshake measurement
	 * leaves it alone: an escape hatch that moves by itself is not one.
	 */
	/**
	 * @param floor Lowest the delay may be walked to. The caller supplies it
	 * because only the session is measuring the link - see `autoFloor`. Left
	 * out, it is the two frames a relay path earns.
	 */
	observePeerStrain(
		strain: number,
		current: number,
		nowMs: number,
		floor: number = MIN_AUTO_DELAY
	): DelayVerdict {
		if (!this._automatic || this.hungerSeconds <= 0) return null;

		const second = Math.floor(nowMs / 1000);
		if (this.strainedAt < 0) {
			this.strainedAt = 0;
			this.strainedSecond = second;
		} else if (second > this.strainedSecond) {
			const elapsed = second - this.strainedSecond;
			this.observedSeconds = Math.min(STRAIN_WINDOW_SECONDS, this.observedSeconds + elapsed);
			if (elapsed >= STRAIN_WINDOW_SECONDS) {
				// A gap longer than the window means nothing inside it is still
				// relevant. Clearing beats walking the ring, and beats replaying a
				// stall or a backgrounded tab as thirty strained seconds.
				this.strainedRing.fill(0);
				this.strainedCount = 0;
				this.strainedAt = 0;
			} else {
				for (let i = 0; i < elapsed; i++) {
					this.strainedAt = (this.strainedAt + 1) % STRAIN_WINDOW_SECONDS;
					this.strainedCount -= this.strainedRing[this.strainedAt];
					this.strainedRing[this.strainedAt] = 0;
				}
			}
			this.strainedSecond = second;
		}

		// One strained second, no matter how many packets inside it said so.
		if (strain >= STRAIN_AT && this.strainedRing[this.strainedAt] === 0) {
			this.strainedRing[this.strainedAt] = 1;
			this.strainedCount++;
		}

		if (this.strainedCount >= this.hungerSeconds) {
			if (current >= MAX_INPUT_DELAY) return null;
			/*
			 * Start the window over rather than demanding twice the evidence next
			 * time. The frame either helped, in which case strain falls and this
			 * will not qualify again, or the link is genuinely worse than one frame
			 * can cover, in which case it will - and should.
			 */
			this.resetWindow();
			return { delta: 1, reason: 'to keep the other player smooth' };
		}

		if (
			this.observedSeconds >= STRAIN_WINDOW_SECONDS &&
			this.strainedCount === 0 &&
			current - 1 >= floor
		) {
			this.resetWindow();
			return { delta: -1, reason: 'the link has been quiet' };
		}

		return null;
	}

	/**
	 * Forgets what the previous link was doing.
	 *
	 * Called when the session moves onto a different path - the relay giving way
	 * to a direct channel. Strain gathered over the old one describes a link
	 * that is no longer carrying anything, and left in the ring it would spend
	 * the next window pushing the delay back up over a channel that never
	 * strained at all.
	 *
	 * The observed count goes with it: a fresh window of evidence is exactly
	 * what the new path owes before it may be walked down again.
	 */
	pathChanged(): void {
		this.resetWindow();
	}

	noteSizingPing(): void {
		this._sizingPings++;
	}
	addSizingSample(rtt: number): void {
		this._sizingSamples.push(rtt);
	}
	get sizingPings(): number {
		return this._sizingPings;
	}
	get sizingSamples(): readonly number[] {
		return this._sizingSamples;
	}

	/**
	 * Whether the host has enough of the burst to ship the initial state.
	 *
	 * A session that never starts is worse than one sized on the default, so a
	 * quiet link gives up waiting rather than blocking the handshake.
	 */
	sizingVerdict(startedAt: number, nowMs: number): 'wait' | 'ship' {
		const elapsed = nowMs - startedAt;
		if (this._sizingSamples.length >= SIZING_SAMPLES) return 'ship';
		if (this._sizingSamples.length > 0 && elapsed > SIZING_BUDGET_MS) return 'ship';
		if (elapsed > 1000) return 'ship';
		return 'wait';
	}

	/** The delay the burst asks for, or null if it should not override. */
	sizedDelay(): number | null {
		if (!this._automatic || this._sizingSamples.length === 0) return null;
		return suggestInputDelay(this._sizingSamples, this.fps);
	}
}
