/**
 * A whole two-player netplay session on a virtual clock.
 *
 * The real lockstep engine and the real wire protocol; only the network and
 * the passage of time are simulated. A 60-second match with 150ms of latency
 * and 5% packet loss therefore runs in a couple of seconds and produces the
 * exact same result every time, which is what makes desync hunting tractable.
 *
 * The core is injected: FakeCore for fast protocol tests, the real wasm core
 * for "does snes9x actually stay bit-identical" tests.
 */

import {
	NetplaySession,
	type NetplayCore,
	type SessionEvent
} from '../../frontend/src/lib/znet/session.js';
import { SimulatedLink, type SimulatedLinkOptions } from '../../frontend/src/lib/znet/transport.js';

export interface HarnessOptions {
	/** Builds a fresh, independent machine. Called once per peer. */
	makeCore: () => Promise<NetplayCore> | NetplayCore;
	romCrc: number;
	link?: SimulatedLinkOptions;
	inputDelay?: number;
	crcInterval?: number;
	padRedundancy?: number;
	retryMs?: number;
	stateChunkSize?: number;
	/** Emulated frames per second. PAL is 50.007, NTSC 60.0988. */
	fps?: number;
	hungerSeconds?: number;
	/** Pads indexed by the frame they apply to. */
	hostInput?: number[];
	guestInput?: number[];
}

export interface Peer {
	name: 'host' | 'guest';
	core: NetplayCore;
	session: NetplaySession;
	events: SessionEvent[];
	/** Work-RAM CRC after each executed frame, keyed by frame number. */
	crcLog: Map<number, number>;
}

export class NetplayHarness {
	readonly link: SimulatedLink;
	readonly host: Peer;
	readonly guest: Peer;

	/** Virtual milliseconds since the harness was created. */
	time = 0;

	private constructor(link: SimulatedLink, host: Peer, guest: Peer) {
		this.link = link;
		this.host = host;
		this.guest = guest;
	}

	static async create(options: HarnessOptions): Promise<NetplayHarness> {
		const link = new SimulatedLink(options.link ?? { latency: 40 });

		const hostCore = await options.makeCore();
		const guestCore = await options.makeCore();

		const harness = new NetplayHarness(
			link,
			{ name: 'host', core: hostCore, session: null!, events: [], crcLog: new Map() },
			{ name: 'guest', core: guestCore, session: null!, events: [], crcLog: new Map() }
		);

		const hostInput = options.hostInput ?? [];
		const guestInput = options.guestInput ?? [];

		const common = {
			romCrc: options.romCrc,
			// Passed through as given: undefined means "let the host size it
			// from the link", which is the default the app uses. Substituting a
			// number here silently disabled that path and made the test that
			// covers it pass against nothing.
			inputDelay: options.inputDelay,
			crcInterval: options.crcInterval ?? 60,
			padRedundancy: options.padRedundancy ?? 6,
			retryMs: options.retryMs ?? 1500,
			stateChunkSize: options.stateChunkSize ?? 16 * 1024,
			// The engine has to know the machine's cadence: it sizes the delay in
			// frames and measures jitter against the spacing one frame implies.
			fps: options.fps,
			hungerSeconds: options.hungerSeconds
		};

		const attach = (peer: Peer, isHost: boolean, tape: number[]) => {
			peer.session = new NetplaySession({
				...common,
				core: peer.core,
				transport: isHost ? link.a : link.b,
				playerIndex: isHost ? 0 : 1,
				isHost,
				// Indexed by the frame the pad applies to, not by when it was
				// read, so both peers replay the identical tape no matter how
				// the stalls fall.
				// Reads the session's own delay, which the host may have sized from
				// the link rather than been given.
				readLocalInput: () => tape[peer.session.currentFrame + peer.session.inputDelay] ?? 0,
				onEvent: (e) => peer.events.push(e),
				onFrame: (frame) => peer.crcLog.set(frame - 1, peer.core.wramCrc())
			});
			peer.session.now = () => harness.time;
		};

		attach(harness.host, true, hostInput);
		attach(harness.guest, false, guestInput);

		return harness;
	}

	start(): void {
		this.host.session.start();
		this.guest.session.start();
	}

	/**
	 * Runs the session forward in virtual time.
	 *
	 * Each peer keeps its own frame accumulator, so a peer that stalls falls
	 * behind in emulated frames while wall-clock time keeps moving - exactly
	 * what happens in a browser.
	 */
	run(
		virtualMs: number,
		options: { fps?: number; stepMs?: number; stopWhen?: () => boolean } = {}
	): void {
		const fps = options.fps ?? 60.0988;
		const step = options.stepMs ?? 1;
		const frameTime = 1000 / fps;
		const accumulators = new Map<Peer, number>([
			[this.host, 0],
			[this.guest, 0]
		]);

		const end = this.time + virtualMs;
		while (this.time < end) {
			this.link.advance(step);
			this.time += step;

			for (const peer of [this.host, this.guest]) {
				peer.session.pump();
				let acc = accumulators.get(peer)! + step;
				// One tick attempt per due frame. A stall breaks out and the
				// accumulated time stays banked for when the pad arrives.
				while (acc >= frameTime) {
					if (peer.session.tick() !== 'ran') break;
					acc -= frameTime;
					// Checked between ticks, not once per step: peers routinely
					// sit one frame apart, and a condition sampled only after
					// both have ticked never sees the instant they are equal.
					if (options.stopWhen?.()) {
						accumulators.set(peer, acc);
						return;
					}
				}
				// Cap the debt so a long stall does not cause a sprint.
				accumulators.set(peer, Math.min(acc, frameTime * 8));
			}

			if (options.stopWhen?.()) return;
		}
	}

	/** Runs until both peers are playing, or throws. */
	handshake(timeoutMs = 20000): void {
		this.start();
		this.run(timeoutMs, {
			stopWhen: () =>
				this.host.session.state === 'running' && this.guest.session.state === 'running'
		});
		if (this.host.session.state !== 'running' || this.guest.session.state !== 'running') {
			throw new Error(
				`handshake failed: host=${this.host.session.state} guest=${this.guest.session.state}`
			);
		}
	}

	/**
	 * Runs until both peers sit on the same frame number, then compares their
	 * full machine state.
	 *
	 * Peers are normally a frame or two apart - one is always waiting on the
	 * other's pad - so comparing states at an arbitrary moment proves nothing.
	 * This waits for a moment where the comparison is meaningful.
	 */
	statesMatchWhenAligned(timeoutMs = 5000): boolean {
		const aligned = () => this.host.session.currentFrame === this.guest.session.currentFrame;
		this.run(timeoutMs, { stopWhen: aligned });

		// Both peers tick inside the same time step, so a steady one- or
		// two-frame offset can persist without either sampling point ever
		// finding them equal. Advance whichever is behind, on its own, until
		// they meet.
		for (let i = 0; i < 1000 && !aligned(); i++) {
			const behind =
				this.host.session.currentFrame < this.guest.session.currentFrame ? this.host : this.guest;
			if (behind.session.tick() !== 'ran') {
				// It is waiting on a pad: let the link deliver and try again.
				this.link.advance(1);
				this.time += 1;
				this.host.session.pump();
				this.guest.session.pump();
			}
		}

		if (!aligned()) {
			throw new Error(
				`peers never aligned: host=${this.host.session.currentFrame} guest=${this.guest.session.currentFrame}`
			);
		}
		return this.host.core.stateCrc() === this.guest.core.stateCrc();
	}

	/**
	 * First frame where the two peers' CRC logs disagree, or null.
	 * Only frames both peers actually executed are compared.
	 */
	firstDivergence(): number | null {
		const frames = [...this.host.crcLog.keys()].filter((f) => this.guest.crcLog.has(f));
		frames.sort((a, b) => a - b);
		for (const frame of frames) {
			if (this.host.crcLog.get(frame) !== this.guest.crcLog.get(frame)) return frame;
		}
		return null;
	}

	/** Frames both peers have executed, and therefore compared. */
	get comparedFrames(): number {
		let count = 0;
		for (const frame of this.host.crcLog.keys()) if (this.guest.crcLog.has(frame)) count++;
		return count;
	}

	clearLogs(): void {
		this.host.crcLog.clear();
		this.guest.crcLog.clear();
	}

	dispose(): void {
		this.host.session.close();
		this.guest.session.close();
	}
}
