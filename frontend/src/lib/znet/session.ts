/**
 * ZSNES-style lockstep netplay.
 *
 * The model is deliberately the old one, not rollback:
 *
 *   - Both peers run the same deterministic core from the same savestate.
 *   - Local input read on frame F is scheduled for frame F+D ("input delay"),
 *     which is the window the pad packet has to cross the network in.
 *   - A frame does not run until every player's pad for it has arrived. If a
 *     packet is late the emulator simply waits, exactly like ZSNES does.
 *   - A checksum is exchanged periodically; if it ever differs the host ships
 *     a full savestate and both sides restart from it.
 *
 * No prediction, no rollback, no speculative frames. The upside is that it is
 * small enough to reason about and it cannot produce the "correct locally,
 * wrong remotely" class of bug; the cost is D frames of input latency and a
 * hard stall whenever the network hiccups.
 *
 * The engine owns no timers. Everything happens inside `tick()`, so the test
 * suite drives entire sessions through a virtual clock at full CPU speed.
 */

import type { Transport } from './transport.js';
import { compress, decompress } from './compress.js';
import {
	MsgType,
	PROTOCOL_VERSION,
	decode,
	encode,
	type NetMsg,
	type PadMask,
	type StateMsg
} from './protocol.js';

/**
 * What the session needs from an emulator, and nothing more.
 *
 * PsnesCore satisfies this, but so does a twenty-line fake. That matters: the
 * netcode's own edge cases - reordering, resync, epoch handling - are worth
 * testing at full speed without a 4MB wasm module and a ROM in the loop.
 */
export interface NetplayCore {
	runFrame(pad1: number, pad2: number): void;
	frame: number;
	saveState(): Uint8Array;
	loadState(state: Uint8Array): void;
	wramCrc(): number;
	stateCrc(): number;
}

export type SessionState =
	| 'idle'
	| 'handshake'
	| 'syncing'
	| 'running'
	| 'resyncing'
	| 'failed'
	| 'closed';

export type TickResult = 'ran' | 'stalled' | 'idle';

/**
 * What FrameGovernor needs from a session, and nothing more.
 *
 * The governor is the only timer owner in this stack, and of a session it
 * calls exactly these two methods. Naming them separately from
 * NetplaySession is what lets solo play reuse the governor without dragging
 * in a handshake, an input delay and a resync path that mean nothing with
 * one player.
 */
export interface TickSource {
	/** Cheap out-of-band work: retries, probes. Called once per slice. */
	pump(): void;
	/** Advance at most one frame. */
	tick(): TickResult;
}

export interface SessionEvent {
	type:
		| 'state'
		| 'desync'
		| 'resync-start'
		| 'resync-done'
		| 'rtt'
		/**
		 * The link has gone quiet, and may yet come back. Distinct from
		 * 'error' because it is retractable: the engine re-sends pads while
		 * stalled precisely so that play resumes by itself, and a consumer
		 * that treats this as terminal freezes a session that recovered.
		 */
		| 'link-lost'
		| 'link-restored'
		| 'error'
		| 'peer-ready';
	message?: string;
	frame?: number;
	value?: number;
}

export interface SessionOptions {
	core: NetplayCore;
	transport: Transport;
	/** 0 for the host (controller port 1), 1 for the guest (port 2). */
	playerIndex: number;
	isHost: boolean;
	/** CRC32 of the ROM, so a mismatched cartridge fails at handshake. */
	romCrc: number;
	/**
	 * Frames of input delay. Omit it - or pass 0 - to have the host size it
	 * from the measured round trip; pass a number to pin it, which is what
	 * ZSNES exposes as a manual setting.
	 */
	inputDelay?: number;
	/** Frames between checksum exchanges. 0 disables desync detection. */
	crcInterval?: number;
	/** How many already-sent frames each pad packet repeats. */
	padRedundancy?: number;
	/** Bytes per savestate chunk. */
	stateChunkSize?: number;
	/** How long to wait for a HELLO or a STATE_ACK before resending, in ms. */
	retryMs?: number;
	/** How often to measure RTT, in ms. 0 disables. */
	pingIntervalMs?: number;
	/** Re-send our pads every N consecutive stalled ticks. */
	stallResendEvery?: number;
	readLocalInput: () => PadMask;
	onEvent?: (event: SessionEvent) => void;
	onFrame?: (frame: number) => void;
}

const PLAYER_COUNT = 2;

/**
 * Floor for the *automatic* delay, which is symmetric: both peers get the same
 * number, so three each covers a round trip of about 100ms with no stalls at
 * all. Lowering it would have to be paid for by everybody, including the pairs
 * whose link cannot afford it.
 */
const MIN_INPUT_DELAY = 3;
/**
 * Floor for a delay someone set on purpose.
 *
 * Because the requirement is on the sum, a peer can sit well under the
 * automatic floor as long as its partner sits above: on a 90ms round trip a
 * 1/5 split runs with exactly as few stalls as 3/3 and the player on the short
 * end feels 17ms instead of 50. Zero is not offered - with no lead at all every
 * frame waits a full one-way trip.
 */
const MIN_MANUAL_DELAY = 1;
/** Hard ceiling. Past sixteen frames the game is unplayable anyway. */
const MAX_INPUT_DELAY = 16;

/**
 * SNES NTSC frame time. The engine is otherwise cadence-agnostic - the governor
 * owns the clock - but the jitter estimate needs to know what spacing a pad
 * packet per frame implies, and the delay estimator already assumes the same
 * 60.0988Hz by default.
 */
const FRAME_MS = 1000 / 60.0988;

/** Round-trip samples the host collects before sizing the input delay. */
const SIZING_SAMPLES = 5;
/** Gap between the pings of the sizing burst, in ms. */
const SIZING_PING_GAP_MS = 60;
/** How long the host waits for the burst before sizing on what it has. */
const SIZING_BUDGET_MS = 700;
/**
 * Frames of input delay for a set of round-trip samples.
 *
 * Lives here rather than in the barrel so the netcode keeps a single copy of
 * it: this file is deliberately free of imports beyond the protocol and the
 * transport, and index.ts re-exports this function rather than restating it.
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
export function suggestInputDelay(samples: number[] | number, fps = 60.0988): number {
	const all = typeof samples === 'number' ? [samples] : samples;
	if (all.length === 0) return MIN_INPUT_DELAY;
	const sorted = [...all].sort((a, b) => a - b);
	const considered = sorted.length >= 3 ? sorted.slice(0, -1) : sorted;
	const best = considered[0];
	const spread = considered[considered.length - 1] - best;
	const frameMs = 1000 / fps;
	const needed = Math.ceil((best + spread) / 2 / frameMs) + 1;
	return Math.max(MIN_INPUT_DELAY, Math.min(MAX_INPUT_DELAY, needed));
}

/** Reships tolerated before a host gives up and restarts the handshake. */
const MAX_SHIP_ATTEMPTS = 6;

/** Silence from the peer, in ms, past which the session is reported as lost. */
const SILENCE_MS = 15_000;

export interface SessionStats {
	frame: number;
	framesRun: number;
	stalls: number;
	stalledTicks: number;
	inputDelay: number;
	rtt: number | null;
	/**
	 * Variation in how the peer's pads arrive, in ms, or null before any have.
	 *
	 * The number that decides the input delay. Latency alone costs a one-off
	 * offset between the peers; it is the *variation* that leaves a pad late for
	 * the frame that needed it, so at a fixed 60ms round trip a link with 12ms of
	 * jitter needs more than twice the delay of one with 3ms. Shown next to the
	 * round trip because a player tuning the delay is really tuning against this.
	 */
	jitter: number | null;
	epoch: number;
	desyncs: number;
	resyncs: number;
	packetsSent: number;
	packetsReceived: number;
	/**
	 * Frames of input already held beyond the current frame, per player.
	 *
	 * The single most diagnostic number in a stalled session: if the remote
	 * entry sits at zero the pads are not arriving, and if it is healthy while
	 * nothing advances the problem is not the network at all.
	 */
	padsAhead: number[];
}

export class NetplaySession implements TickSource {
	readonly isHost: boolean;
	readonly playerIndex: number;

	private core: NetplayCore;
	private transport: Transport;
	private opts: Required<
		Pick<
			SessionOptions,
			| 'inputDelay'
			| 'crcInterval'
			| 'padRedundancy'
			| 'stateChunkSize'
			| 'retryMs'
			| 'pingIntervalMs'
			| 'stallResendEvery'
		>
	>;
	private readLocalInput: () => PadMask;
	private onEvent: (event: SessionEvent) => void;
	private onFrame: (frame: number) => void;
	private romCrc: number;

	private _state: SessionState = 'idle';
	private epoch = 0;

	/** Next frame to execute. Mirrors the core's own frame counter. */
	private frame = 0;
	/** First frame of the current epoch; nothing before it is meaningful. */
	private baseFrame = 0;

	private pads: Array<Map<number, PadMask>> = [new Map(), new Map()];

	private localCrcs = new Map<number, number>();
	private remoteCrcs = new Map<number, number>();

	/**
	 * The last savestate this peer adopted. State delivery is idempotent: a
	 * duplicate chunk that arrives after adoption is answered with another ack
	 * rather than restarting the transfer.
	 */
	private adopted: { epoch: number; frame: number } | null = null;

	/** Assembly buffer for an incoming savestate. */
	private incoming: {
		epoch: number;
		frame: number;
		total: number;
		chunks: Map<number, Uint8Array>;
		chunkCount: number;
	} | null = null;

	/** Consecutive stalled ticks, used to pace pad re-sends. */
	private stallCounter = 0;

	private peerHello = false;
	private pendingPings = new Map<number, number>();
	private nextPingId = 1;
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

	/** Debounces the rejoin handling so a duplicate HELLO cannot loop. */
	private lastRejoinAt = 0;

	/** When the host started waiting for a round-trip sample before shipping. */
	private sizingSince = 0;
	/** Raw round-trip samples gathered during the sizing burst. */
	private sizingSamples: number[] = [];
	/** Pings the sizing burst has sent so far. */
	private sizingPings = 0;
	/** False when the caller pinned the delay, so measurement must not override it. */
	private autoInputDelay: boolean;

	/**
	 * Largest delay used this epoch.
	 *
	 * The stall re-send and the history pruner have to reach back as far as the
	 * peer might still be lagging, which the biggest delay either side has used
	 * sets - not the current one. Shrinking these windows along with the delay
	 * would reopen the deadlock the re-send exists to break.
	 */
	private epochMaxDelay = 0;

	/** Reships of the current state that have gone unacknowledged. */
	private shipAttempts = 0;

	/** Last time anything at all arrived from the peer. */
	private lastPacketAt = 0;
	private reportedSilence = false;

	/** Wall-clock bookkeeping for the retry logic in `pump()`. */
	private helloSentAt = 0;
	private stateShippedAt = 0;
	private lastPingAt = 0;

	private stats: SessionStats = {
		frame: 0,
		framesRun: 0,
		stalls: 0,
		stalledTicks: 0,
		inputDelay: 0,
		rtt: null,
		jitter: null,
		epoch: 0,
		desyncs: 0,
		resyncs: 0,
		packetsSent: 0,
		packetsReceived: 0,
		padsAhead: [0, 0]
	};

	/** Injected so tests can run on a virtual clock. */
	now: () => number = () => Date.now();

	constructor(options: SessionOptions) {
		this.core = options.core;
		this.transport = options.transport;
		this.playerIndex = options.playerIndex;
		this.isHost = options.isHost;
		this.romCrc = options.romCrc >>> 0;
		this.readLocalInput = options.readLocalInput;
		this.onEvent = options.onEvent ?? (() => {});
		this.onFrame = options.onFrame ?? (() => {});
		this.autoInputDelay = !options.inputDelay;
		this.opts = {
			inputDelay: options.inputDelay || 5,
			crcInterval: options.crcInterval ?? 60,
			padRedundancy: options.padRedundancy ?? 6,
			stateChunkSize: options.stateChunkSize ?? 16 * 1024,
			retryMs: options.retryMs ?? 1500,
			pingIntervalMs: options.pingIntervalMs ?? 2000,
			stallResendEvery: options.stallResendEvery ?? 8
		};
		this.stats.inputDelay = this.opts.inputDelay;
		this.epochMaxDelay = this.opts.inputDelay;

		this.transport.onMessage((data) => this.handleMessage(data));
	}

	get state(): SessionState {
		return this._state;
	}

	get currentFrame(): number {
		return this.frame;
	}

	get inputDelay(): number {
		return this.opts.inputDelay;
	}

	/**
	 * Overrides the input delay for this peer alone.
	 *
	 * Needs no agreement from the peer, which is the useful part: pads are
	 * keyed by absolute frame, so past the startup priming window the delay
	 * governs nothing but how far ahead this side samples its own input.
	 *
	 * That makes input latency a budget the two players can split unevenly.
	 * Sixty frames per second is sustainable whenever the two delays cover the
	 * round trip between them - `Dh + Dg >= rtt / frameMs`, because a frame
	 * needs the peer's pad from `Dh` frames ago and the peer's needed ours from
	 * `Dg` frames before that - so a player who cannot stand the lag can take
	 * three frames while the other takes nine. Neither has to cover the one-way
	 * trip alone.
	 *
	 * Pins the delay, the same way passing `inputDelay` to the constructor
	 * does, so measurement will not undo it. A resync still re-imposes the
	 * host's value on the guest: priming the startup pads does require the two
	 * to agree.
	 */
	setInputDelay(frames: number): void {
		this.autoInputDelay = false;
		this.setDelay(Math.max(MIN_MANUAL_DELAY, Math.min(MAX_INPUT_DELAY, Math.round(frames))));
	}

	private setDelay(frames: number): void {
		const previous = this.opts.inputDelay;
		this.opts.inputDelay = frames;
		this.stats.inputDelay = frames;
		this.epochMaxDelay = Math.max(this.epochMaxDelay, frames);

		if (frames <= previous || this._state !== 'running') return;

		/*
		 * Raising the delay leaves a hole, and the hole is permanent.
		 *
		 * `tick()` only ever fills `frame + delay`, one entry per executed
		 * frame. Push the horizon out by four frames and the four between the
		 * old horizon and the new one are skipped for good: nothing targets
		 * them again as `frame` advances, so the peer waits on pads that will
		 * never be sent and the session wedges a few frames later.
		 *
		 * Repeat the newest pad across the gap. It is the only value available
		 * without inventing input the player never gave, and repeating recent
		 * frames is what the pad packets do anyway.
		 */
		const mine = this.pads[this.playerIndex];
		const last = mine.get(this.frame + previous) ?? 0;
		for (let f = this.frame + previous + 1; f <= this.frame + frames; f++) {
			if (!mine.has(f)) mine.set(f, last);
		}
		this.sendPadRange(this.frame + previous + 1, this.frame + frames);
	}

	get rtt(): number | null {
		return this._rtt;
	}

	get jitter(): number | null {
		return this._jitter;
	}

	getStats(): SessionStats {
		const padsAhead = this.pads.map((map) => {
			let ahead = 0;
			while (map.has(this.frame + ahead)) ahead++;
			return ahead;
		});
		return {
			...this.stats,
			frame: this.frame,
			rtt: this._rtt,
			jitter: this._jitter,
			epoch: this.epoch,
			padsAhead
		};
	}

	/** Begins the handshake. Both peers call this; order does not matter. */
	start(): void {
		if (this._state !== 'idle') return;
		this.setState('handshake');
		this.sendHello();
		this.ping();
	}

	/**
	 * Time-driven housekeeping: handshake and savestate retries, RTT probes.
	 *
	 * Kept out of `tick()` because `tick()` must stay a pure function of the
	 * message log - that is what lets the tests replay a session exactly. Call
	 * this from whatever drives real time; a few times a second is plenty.
	 */
	pump(): void {
		const now = this.now();
		if (this.lastPacketAt === 0) this.lastPacketAt = now;

		/*
		 * Say when the link has gone quiet.
		 *
		 * A peer whose packets are being dropped - its seat given away, its
		 * socket gone - looks exactly like a peer who is briefly slow: the
		 * session stays 'running' and stalls for ever on a pad that will never
		 * come. Without this the screen reads "waiting for the other player"
		 * indefinitely, with nothing to distinguish a hiccup from a session
		 * that is over.
		 */
		if (
			this._state === 'running' &&
			!this.reportedSilence &&
			now - this.lastPacketAt > SILENCE_MS
		) {
			this.reportedSilence = true;
			this.onEvent({
				type: 'link-lost',
				message: 'Lost contact with the other player. Play resumes as soon as the link is back.'
			});
		}

		if (this._state === 'handshake' && now - this.helloSentAt >= this.opts.retryMs) {
			/*
			 * Keep announcing until we are actually out of the handshake, even
			 * once the peer has said hello to us.
			 *
			 * Hearing a HELLO says nothing about whether ours was heard. The two
			 * players join the relay channel at different moments, and anything
			 * sent before the other has joined is dropped by the server with no
			 * error. Guarding this on "has the peer spoken" silenced precisely
			 * the peer whose greeting had gone missing, and both then waited on
			 * each other for ever.
			 *
			 * The host leaves this state as soon as a HELLO reaches it; the
			 * guest leaves it when the state arrives. Neither can loop.
			 */
			this.sendHello();
		}

		/*
		 * Keep the sizing burst going.
		 *
		 * The delay for the whole session comes out of these few samples, and
		 * one sample is the worst possible basis: a session's first round trip
		 * carries the socket and the relay waking up and reads far above the
		 * link, so sizing on it priced every match for a latency that never
		 * came back. The pings go out back to back rather than at the leisurely
		 * running interval, which spends a few hundred milliseconds of
		 * handshake instead of a frame of latency for the whole session.
		 */
		if (
			this.isHost &&
			this._state === 'syncing' &&
			this.stateShippedAt === 0 &&
			this.sizingSince > 0 &&
			this.sizingPings < SIZING_SAMPLES &&
			now - this.lastPingAt >= SIZING_PING_GAP_MS
		) {
			this.sizingPings++;
			this.ping();
		}

		// Ship the initial state once the burst is in, or anyway if the link
		// stays quiet - a session that never starts is worse than one sized on
		// the default.
		if (
			this.isHost &&
			this._state === 'syncing' &&
			this.stateShippedAt === 0 &&
			this.sizingSince > 0 &&
			(this.sizingSamples.length >= SIZING_SAMPLES ||
				(this.sizingSamples.length > 0 && now - this.sizingSince > SIZING_BUDGET_MS) ||
				now - this.sizingSince > 1000)
		) {
			if (this.sizingSamples.length > 0 && this.autoInputDelay) {
				const sized = suggestInputDelay(this.sizingSamples);
				if (sized !== this.opts.inputDelay) {
					const best = Math.round(Math.min(...this.sizingSamples));
					this.onEvent({
						type: 'state',
						message: `input delay ${sized} frames from ${this.sizingSamples.length} samples, best ${best}ms`
					});
				}
				this.setDelay(sized);
			}
			this.sizingSince = 0;
			this.resetTimeline(this.core.frame);
			this.shipState(this.frame);
			return;
		}

		if (
			this.isHost &&
			(this._state === 'syncing' || this._state === 'resyncing') &&
			this.stateShippedAt > 0 &&
			now - this.stateShippedAt >= this.opts.retryMs
		) {
			this.shipAttempts++;

			/*
			 * Give up rather than reship forever.
			 *
			 * A host waiting on an acknowledgement it will never get is wedged
			 * for good: it stops running frames, so it stops sending pads, and
			 * the peer sits at "waiting for the other player" indefinitely.
			 * Falling back to a full handshake costs a restart of the session,
			 * which is far better than a session nobody can leave.
			 */
			if (this.shipAttempts > MAX_SHIP_ATTEMPTS) {
				// Reuses the silence flag rather than firing a bare event: handleMessage()
				// only announces 'link-restored' when reportedSilence is set, and the
				// restarted handshake below will succeed once the peer answers again, so
				// without this the UI would be left holding a notice it can never clear.
				this.reportedSilence = true;
				this.onEvent({
					type: 'link-lost',
					message: 'the other player stopped responding; restarting the session'
				});
				this.shipAttempts = 0;
				this.adopted = null;
				this.incoming = null;
				this.peerHello = false;
				this.stateShippedAt = 0;
				this.setState('handshake');
				this.sendHello();
				return;
			}

			// Savestate chunks are the one message with no built-in redundancy
			// (they are far too big to repeat), so a dropped chunk is repaired
			// by shipping the state again.
			this.shipState(this.frame);
		}

		if (this.opts.pingIntervalMs > 0 && now - this.lastPingAt >= this.opts.pingIntervalMs) {
			this.ping();
		}
	}

	close(): void {
		this.setState('closed');
		this.transport.close();
	}

	/**
	 * Runs at most one emulated frame.
	 *
	 * Returns 'stalled' when a pad has not arrived yet - the caller should try
	 * again rather than skipping the frame, because skipping is what desyncs a
	 * lockstep session.
	 */
	tick(): TickResult {
		if (this._state !== 'running') return 'idle';

		// Sample local input for the frame it will actually apply to. Doing
		// this once per executed frame (rather than once per wall-clock tick)
		// is what keeps the two peers' input tapes the same length.
		const target = this.frame + this.opts.inputDelay;
		if (!this.pads[this.playerIndex].has(target)) {
			const pad = this.readLocalInput() & 0xffff;
			this.pads[this.playerIndex].set(target, pad);
			this.sendPads(target);
		}

		if (!this.hasAllPads(this.frame)) {
			if (this.stallCounter === 0) this.stats.stalls++;
			this.stats.stalledTicks++;

			// Re-send our own pending pads while stalled.
			//
			// Without this a session never recovers from an outage: the pad the
			// peer is waiting for was sent once, was lost, and will never be
			// sent again because no new frame runs to trigger a new packet.
			// Both sides then wait on each other forever.
			if (this.stallCounter > 0 && this.stallCounter % this.opts.stallResendEvery === 0) {
				// Send everything the peer could still be missing, not just the
				// usual redundancy window. A peer can legitimately sit up to
				// `inputDelay + 1` frames behind us, so a window shorter than
				// that leaves a hole the re-send never fills and the deadlock
				// this exists to break simply persists.
				this.sendPadRange(this.frame - this.epochMaxDelay - 1, target);
			}
			this.stallCounter++;
			return 'stalled';
		}
		this.stallCounter = 0;

		const pad1 = this.pads[0].get(this.frame) ?? 0;
		const pad2 = this.pads[1].get(this.frame) ?? 0;

		this.core.runFrame(pad1, pad2);
		const executed = this.frame;
		this.frame++;
		this.stats.framesRun++;

		this.maybeChecksum(executed);
		this.pruneHistory();
		this.onFrame(this.frame);

		return 'ran';
	}

	/**
	 * Replaces the emulated machine and reseeds the peer from it.
	 *
	 * Loading a savestate on one side only is an instant, total desync - the
	 * two machines stop being the same machine. Routing it through the epoch
	 * mechanism makes it the same operation as a resync: the host adopts the
	 * state, the guest is handed it, and everything still in flight from the
	 * previous timeline is discarded.
	 *
	 * Host only. The frame counter deliberately keeps running: the timeline
	 * continues, it is the machine on it that jumps.
	 */
	loadAuthoritativeState(state: Uint8Array, reason = 'state loaded'): boolean {
		if (!this.isHost) return false;
		if (this._state !== 'running') return false;
		try {
			this.core.loadState(state);
		} catch (err) {
			this.onEvent({ type: 'error', message: `Could not load that save: ${(err as Error).message}` });
			return false;
		}
		this.beginResync(reason, true);
		return true;
	}

	/** Restarts the emulated machine on both peers. Host only. */
	resetAuthoritative(): boolean {
		if (!this.isHost || this._state !== 'running') return false;
		this.coreReset?.();
		this.beginResync('reset', true);
		return true;
	}

	/** Optional hook: the core's reset, which NetplayCore does not require. */
	coreReset: (() => void) | null = null;

	/** Forces a resync from the host's current state. Host only. */
	requestResync(reason = 'manual'): void {
		if (!this.isHost) {
			this.send({ type: MsgType.Desync, epoch: this.epoch, frame: this.frame });
			return;
		}
		this.beginResync(reason);
	}

	ping(): void {
		const id = this.nextPingId++;
		this.lastPingAt = this.now();
		this.pendingPings.set(id, this.lastPingAt);
		this.send({ type: MsgType.Ping, id });
	}

	private sendHello(): void {
		this.helloSentAt = this.now();
		this.send({
			type: MsgType.Hello,
			protocol: PROTOCOL_VERSION,
			romCrc: this.romCrc,
			playerIndex: this.playerIndex,
			playerCount: PLAYER_COUNT
		});
	}

	/* ------------------------------------------------------------ internals */

	private setState(next: SessionState): void {
		if (this._state === next) return;
		this._state = next;
		this.onEvent({ type: 'state', message: next, frame: this.frame });
	}

	private send(msg: NetMsg): void {
		this.stats.packetsSent++;
		this.transport.send(encode(msg));
	}

	/**
	 * Folds one pad packet's arrival into the jitter estimate.
	 *
	 * Only packets whose newest frame has advanced count. Every pad packet
	 * repeats the last few frames the sender already transmitted, and the engine
	 * re-sends the whole reachable range while stalled, so a great many arrivals
	 * carry nothing new - timing those would measure the re-send policy rather
	 * than the link.
	 */
	private sampleJitter(newestFrame: number): void {
		const at = this.now();
		const previous = this.lastPadArrival;
		if (previous === null || newestFrame <= previous.frame) {
			if (previous === null) this.lastPadArrival = { at, frame: newestFrame };
			return;
		}

		// What the spacing should have been: the sender emits one packet per frame
		// it runs, so the frames between the two packets are the intended gap.
		const expected = (newestFrame - previous.frame) * FRAME_MS;
		const drift = Math.abs(at - previous.at - expected);
		// RFC 3550's smoothing, gain 1/16: slow enough that one reordered packet
		// does not move the figure, quick enough to follow a route that changes.
		this._jitter = this._jitter === null ? drift : this._jitter + (drift - this._jitter) / 16;
		this.lastPadArrival = { at, frame: newestFrame };
	}

	private hasAllPads(frame: number): boolean {
		for (let p = 0; p < PLAYER_COUNT; p++) {
			if (!this.pads[p].has(frame)) return false;
		}
		return true;
	}

	private sendPads(upTo: number): void {
		this.sendPadRange(upTo - this.opts.padRedundancy + 1, upTo);
	}

	private sendPadRange(from: number, upTo: number): void {
		const first = Math.max(this.baseFrame, from);
		const run: PadMask[] = [];
		for (let f = first; f <= upTo; f++) {
			const pad = this.pads[this.playerIndex].get(f);
			if (pad === undefined) {
				// A gap means history was pruned; start the run after it.
				run.length = 0;
				continue;
			}
			run.push(pad);
		}
		if (run.length === 0) return;
		this.send({
			type: MsgType.Pads,
			playerIndex: this.playerIndex,
			epoch: this.epoch,
			baseFrame: upTo - run.length + 1,
			pads: run
		});
	}

	/**
	 * Neutral pads for the first D frames of an epoch.
	 *
	 * Nobody can have sent a pad for frame 0 through D-1: those are exactly the
	 * frames whose input would have been sampled before the session existed.
	 * Both peers fill them with "no buttons held", which is the one value they
	 * are guaranteed to agree on.
	 */
	private primeStartupPads(from: number): void {
		for (let p = 0; p < PLAYER_COUNT; p++) {
			for (let f = from; f < from + this.opts.inputDelay; f++) {
				this.pads[p].set(f, 0);
			}
		}
	}

	private pruneHistory(): void {
		// Keep well clear of the re-send window: a pruned pad is one we can no
		// longer retransmit, and the peer may still be waiting for it.
		const cutoff = this.frame - Math.max(120, this.epochMaxDelay * 4);
		if (cutoff <= this.baseFrame) return;
		for (let p = 0; p < PLAYER_COUNT; p++) {
			for (const f of this.pads[p].keys()) {
				if (f < cutoff) this.pads[p].delete(f);
			}
		}
		for (const f of this.localCrcs.keys()) if (f < cutoff) this.localCrcs.delete(f);
		for (const f of this.remoteCrcs.keys()) if (f < cutoff) this.remoteCrcs.delete(f);
	}

	private maybeChecksum(executedFrame: number): void {
		const interval = this.opts.crcInterval;
		if (interval <= 0) return;
		if (executedFrame % interval !== 0) return;

		// Work RAM rather than the full savestate: a serialise per checkpoint
		// would cost milliseconds inside a 16ms budget, and any divergence that
		// matters reaches WRAM within a frame or two anyway.
		const crc = this.core.wramCrc();
		this.localCrcs.set(executedFrame, crc);
		this.send({
			type: MsgType.Crc,
			playerIndex: this.playerIndex,
			epoch: this.epoch,
			frame: executedFrame,
			crc
		});

		const remote = this.remoteCrcs.get(executedFrame);
		if (remote !== undefined) this.compareCrc(executedFrame, crc, remote);
	}

	private compareCrc(frame: number, local: number, remote: number): void {
		if (local === remote) return;
		this.stats.desyncs++;
		this.onEvent({
			type: 'desync',
			frame,
			message: `crc ${local.toString(16)} != ${remote.toString(16)}`
		});
		if (this.isHost) {
			this.beginResync(`crc mismatch at frame ${frame}`);
		} else {
			this.send({ type: MsgType.Desync, epoch: this.epoch, frame });
		}
	}

	/**
	 * Host side of a resync: freeze, bump the epoch, ship the whole machine.
	 *
	 * The epoch bump is what makes this safe under latency. Pad packets from
	 * before the resync are still in flight and describe a timeline that no
	 * longer exists; tagging them lets the receiver drop them instead of
	 * applying them to the new state.
	 */
	private beginResync(reason: string, force = false): void {
		if (!this.isHost) return;
		// `force` is for a peer that just announced itself: a returning player is
		// better information than a resync already in flight, whose target may
		// no longer exist.
		if (!force && this._state !== 'running' && this._state !== 'syncing') return;

		this.setState('resyncing');
		this.shipAttempts = 0;
		this.stats.resyncs++;
		this.epoch = (this.epoch + 1) & 0xff;
		this.onEvent({ type: 'resync-start', frame: this.frame, message: reason });

		this.resetTimeline(this.frame);
		this.shipState(this.frame);
	}

	private resetTimeline(from: number): void {
		this.baseFrame = from;
		this.frame = from;
		this.pads = [new Map(), new Map()];
		this.localCrcs.clear();
		this.remoteCrcs.clear();
		// A new epoch starts from whatever delay the two peers have just agreed
		// on, so the window that has to reach back over a delay change starts
		// there too.
		this.epochMaxDelay = this.opts.inputDelay;
		// Frame numbers mean something different on a new timeline, so the
		// spacing measured across the seam would be nonsense.
		this.lastPadArrival = null;
		this.primeStartupPads(from);
	}

	/**
	 * Compresses before chunking.
	 *
	 * The state shares its socket with the pad packets, so every byte of it
	 * delays them. Uncompressed, an 823KB state kept the pads queued behind it
	 * for the best part of a minute at the start of a session.
	 */
	private shipState(frame: number): void {
		this.stateShippedAt = this.now();
		const state = compress(this.core.saveState());
		const compressed = true;

		const chunkSize = this.opts.stateChunkSize;
		const chunkCount = Math.max(1, Math.ceil(state.length / chunkSize));
		for (let i = 0; i < chunkCount; i++) {
			this.send({
				type: MsgType.State,
				epoch: this.epoch,
				frame,
				totalLength: state.length,
				chunkIndex: i,
				chunkCount,
				// The guest configures itself from these, so they travel with
				// the state rather than in a message that could arrive after it.
				inputDelay: this.opts.inputDelay,
				crcInterval: this.opts.crcInterval,
				compressed,
				payload: state.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, state.length))
			});
		}
	}

	/* ------------------------------------------------------------ receiving */

	private handleMessage(data: Uint8Array): void {
		const msg = decode(data);
		if (!msg) return;
		this.stats.packetsReceived++;
		this.lastPacketAt = this.now();
		if (this.reportedSilence) {
			this.reportedSilence = false;
			this.onEvent({ type: 'link-restored' });
		}

		switch (msg.type) {
			case MsgType.Hello:
				return this.onHello(msg.protocol, msg.romCrc);
			case MsgType.Pads:
				return this.onPads(msg.playerIndex, msg.epoch, msg.baseFrame, msg.pads);
			case MsgType.Crc:
				return this.onCrc(msg.epoch, msg.frame, msg.crc);
			case MsgType.State:
				return this.onStateChunk(msg);
			case MsgType.StateAck:
				return this.onStateAck(msg.epoch);
			case MsgType.Desync:
				if (msg.epoch !== this.epoch) return;
				// The peer noticed before we did. Count it as a detection here
				// too, otherwise the stats claim a resync happened for no reason.
				this.stats.desyncs++;
				if (this.isHost) {
					this.beginResync(`peer reported desync at frame ${msg.frame}`);
				}
				return;
			case MsgType.Ping:
				return this.send({ type: MsgType.Pong, id: msg.id });
			case MsgType.Pong: {
				const sentAt = this.pendingPings.get(msg.id);
				if (sentAt === undefined) return;
				this.pendingPings.delete(msg.id);
				const sample = this.now() - sentAt;
				// Kept raw, and kept apart from the smoothed number below: the
				// delay is sized from the spread across these samples, which an
				// average has already thrown away.
				if (this.sizingSince > 0) this.sizingSamples.push(sample);
				// Light smoothing: a single outlier should not move the number
				// the UI shows, but it should still track a real route change.
				this._rtt = this._rtt === null ? sample : this._rtt * 0.7 + sample * 0.3;
				this.onEvent({ type: 'rtt', value: this._rtt });
				return;
			}
		}
	}

	private onHello(protocol: number, romCrc: number): void {
		if (protocol !== PROTOCOL_VERSION) {
			return this.fail(`protocol mismatch: peer speaks v${protocol}, we speak v${PROTOCOL_VERSION}`);
		}
		if (romCrc !== this.romCrc) {
			// ZSNES refuses to start netplay on mismatched ROMs for the same
			// reason: different cartridges cannot possibly stay in sync, and the
			// failure would otherwise surface as a mysterious desync minutes in.
			return this.fail('ROM mismatch: both players must load the same file');
		}

		this.peerHello = true;
		this.onEvent({ type: 'peer-ready' });

		if (this.isHost && this._state === 'handshake') {
			/*
			 * Do not ship yet: size the input delay from a real measurement
			 * first, in pump().
			 *
			 * The delay travels with the state and the guest adopts it there,
			 * so it has to be right before the state goes out. Measuring now is
			 * also the only clean moment - once the state is in flight it
			 * shares the socket with the pings, and the samples read far higher
			 * than the link really is.
			 */
			this.setState('syncing');
			this.sizingSince = this.now();
			this.sizingSamples = [];
			this.sizingPings = 1;
			this.ping();
			return;
		}

		/*
		 * A HELLO arriving mid-session means the peer restarted - it reloaded,
		 * or its component was torn down and rebuilt. Without this the session
		 * simply died: the survivor stayed in 'running' and stalled forever on
		 * pads from a peer that no longer shared its timeline, which on screen
		 * is an indefinite "waiting for the other player".
		 */
		const now = this.now();
		const mid = this._state === 'running' || this._state === 'resyncing';
		if (!mid || now - this.lastRejoinAt < 2000) return;
		this.lastRejoinAt = now;

		if (this.isHost) {
			// We hold the authoritative machine: pull the returning peer onto it.
			this.beginResync('peer rejoined', true);
		} else {
			// The host is the one that restarted, so its state is gone and it is
			// waiting for a HELLO before it will ship anything. Answer, and let
			// it re-seed the session from wherever it now is.
			this.sendHello();
		}
	}

	private onPads(
		playerIndex: number,
		epoch: number,
		baseFrame: number,
		pads: PadMask[]
	): void {
		if (epoch !== this.epoch) return; // belongs to a timeline we abandoned
		if (playerIndex === this.playerIndex || playerIndex >= PLAYER_COUNT) return;

		this.sampleJitter(baseFrame + pads.length - 1);

		const map = this.pads[playerIndex];
		for (let i = 0; i < pads.length; i++) {
			const f = baseFrame + i;
			if (f < this.frame) continue; // already executed; redundant copy
			// First value wins. A redundant repeat must never overwrite a pad
			// we already ran a frame with.
			if (!map.has(f)) map.set(f, pads[i] & 0xffff);
		}
	}

	private onCrc(epoch: number, frame: number, crc: number): void {
		if (epoch !== this.epoch) return;
		const local = this.localCrcs.get(frame);
		if (local === undefined) {
			this.remoteCrcs.set(frame, crc);
			return;
		}
		this.compareCrc(frame, local, crc);
	}

	private onStateChunk(msg: StateMsg): void {
		if (this.isHost) return;

		// Already living in this state. The chunk is either a straggler from
		// the shipment we assembled, or a re-ship because our ack was lost.
		//
		// Without this, a single late duplicate drops a running guest back to
		// 'syncing' to wait for chunks the host has already stopped sending,
		// and the session hangs there for good.
		if (this.adopted && this.adopted.epoch === msg.epoch && this.adopted.frame === msg.frame) {
			this.send({ type: MsgType.StateAck, epoch: msg.epoch, frame: msg.frame });
			return;
		}

		if (!this.incoming || this.incoming.epoch !== msg.epoch || this.incoming.frame !== msg.frame) {
			this.incoming = {
				epoch: msg.epoch,
				frame: msg.frame,
				total: msg.totalLength,
				chunkCount: msg.chunkCount,
				chunks: new Map()
			};
			this.setState(msg.epoch === this.epoch ? 'syncing' : 'resyncing');
		}

		// Adopt the host's session parameters before the state itself. Priming
		// the startup pads under the wrong input delay would leave the guest
		// waiting on frames the host will never send a pad for.
		this.opts.inputDelay = msg.inputDelay;
		this.opts.crcInterval = msg.crcInterval;
		this.stats.inputDelay = msg.inputDelay;

		this.incoming.chunks.set(msg.chunkIndex, msg.payload);
		if (this.incoming.chunks.size < this.incoming.chunkCount) return;

		const assembled = new Uint8Array(this.incoming.total);
		let offset = 0;
		for (let i = 0; i < this.incoming.chunkCount; i++) {
			const chunk = this.incoming.chunks.get(i);
			if (!chunk) return; // still short a chunk; wait for the retransmit
			assembled.set(chunk, offset);
			offset += chunk.length;
		}

		const { epoch, frame } = this.incoming;
		this.incoming = null;

		let state: Uint8Array;
		try {
			state = msg.compressed ? decompress(assembled) : assembled;
		} catch (err) {
			return this.fail(`could not decompress the synchronisation state: ${(err as Error).message}`);
		}

		try {
			this.core.loadState(state);
		} catch (err) {
			return this.fail(`failed to load synchronisation state: ${(err as Error).message}`);
		}

		this.epoch = epoch;
		this.core.frame = frame;
		this.resetTimeline(frame);
		this.adopted = { epoch, frame };

		this.send({ type: MsgType.StateAck, epoch, frame });
		this.setState('running');
		this.onEvent({ type: 'resync-done', frame });
	}

	private onStateAck(epoch: number): void {
		if (!this.isHost) return;
		if (epoch !== this.epoch) return;
		this.stateShippedAt = 0; // stop retrying
		this.shipAttempts = 0;
		this.setState('running');
		this.onEvent({ type: 'resync-done', frame: this.frame });
	}

	private fail(message: string): void {
		this.setState('failed');
		this.onEvent({ type: 'error', message });
	}
}
