/**
 * A Transport decorator that puts distance between two players on one machine.
 *
 * Two browser windows on a desktop talk to the relay over loopback, so a local
 * session runs at a latency no real pair will ever see. That makes the one
 * question worth asking untestable without a second house: how does the game
 * *feel* at a given input delay, and is a lopsided split better than an even
 * one. This wraps the real transport - the real socket.io path, the real
 * backend, real TCP - and adds the distance on top.
 *
 * The number to pass is the ping you measured to the server, and half of it is
 * spent on each one-way hop. That is not an approximation: a pad really travels
 * `me -> relay -> peer`, so its trip costs my half plus my partner's half. Each
 * side injecting its own half on both send and receive reproduces exactly that,
 * and makes the round trip the session goes on to measure come out at
 * `ping_mine + ping_theirs` - which is what the relay topology gives you in
 * production.
 *
 * Timers here are real, unlike the ones in `transport.ts`: the point is to feel
 * the latency, not to assert something about it. The scheduler is injectable all
 * the same, so the tests do not have to wait.
 */

import { Rng, type Transport } from './transport.js';

export interface LagOptions {
	/** Round trip to the relay in ms, as a ping reports it. Half is spent each way. */
	pingMs: number;
	/** Uniform +/- variation on each one-way hop, in ms. */
	jitterMs?: number;
	/** Fraction of packets dropped outright, 0..1. */
	loss?: number;
	/** Seed for the drop/jitter draw, so a session that misbehaved can be replayed. */
	seed?: number;
	/** Injected by tests so they need no real clock. */
	schedule?: (fn: () => void, ms: number) => unknown;
	cancel?: (handle: unknown) => void;
}

export class LagTransport implements Transport {
	private inner: Transport;
	private oneWay: number;
	private jitter: number;
	private loss: number;
	private rng: Rng;
	private schedule: (fn: () => void, ms: number) => unknown;
	private cancelTimer: (handle: unknown) => void;
	private handler: ((data: Uint8Array) => void) | null = null;
	private closed = false;

	/** Hops still in the air, so `close()` can take them back down. */
	private pending = new Set<{ handle?: unknown }>();

	constructor(inner: Transport, options: LagOptions) {
		this.inner = inner;
		this.oneWay = Math.max(0, options.pingMs) / 2;
		this.jitter = Math.max(0, options.jitterMs ?? 0);
		this.loss = Math.min(1, Math.max(0, options.loss ?? 0));
		this.rng = new Rng(options.seed ?? 0x1a6);
		this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
		this.cancelTimer =
			options.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

		this.inner.onMessage((data) => this.hop(() => this.handler?.(data)));
	}

	/** The session measures the round trip itself, through this decorator. */
	get rtt(): number | null {
		return this.inner.rtt;
	}

	send(data: Uint8Array): void {
		if (this.closed) return;
		// Copy before deferring. The session reuses its encode buffers, so a view
		// held for twenty milliseconds and sent afterwards carries whatever the
		// next packet wrote into it.
		const copy = data.slice();
		this.hop(() => this.inner.send(copy));
	}

	onMessage(handler: (data: Uint8Array) => void): void {
		this.handler = handler;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		// Cancel rather than merely ignore. A delivery that fires after teardown
		// calls a handler whose session is gone, which in a browser surfaces as
		// an exception from a room the player has already left, with nothing left
		// on screen to connect it to.
		for (const token of this.pending) this.cancelTimer(token.handle);
		this.pending.clear();
		this.inner.close();
	}

	/** Holds one packet for its one-way trip, or drops it on the floor. */
	private hop(deliver: () => void): void {
		if (this.closed) return;
		if (this.loss > 0 && this.rng.next() < this.loss) return;

		const wobble = this.jitter > 0 ? (this.rng.next() * 2 - 1) * this.jitter : 0;
		// The token is added before the timer is armed: a scheduler that runs its
		// callback synchronously would otherwise leave an entry behind for a hop
		// that has already landed.
		const token: { handle?: unknown } = {};
		this.pending.add(token);
		token.handle = this.schedule(() => {
			this.pending.delete(token);
			if (!this.closed) deliver();
		}, Math.max(0, this.oneWay + wobble));
	}
}

/**
 * Parses the `lag` query parameter: `ping[,jitter[,loss]]`.
 *
 * Returns null for anything it does not fully understand, including a typo.
 * Running on a link other than the one you think you configured is worse than
 * the parameter not working, because every conclusion drawn from the session is
 * then wrong in a way nothing on screen reveals.
 */
export function parseLag(value: string | null | undefined): LagOptions | null {
	if (!value) return null;
	const parts = value.split(',').map((part) => Number(part.trim()));
	if (parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
	const [pingMs, jitterMs = 0, loss = 0] = parts;
	if (pingMs <= 0 || loss > 1) return null;
	return { pingMs, jitterMs, loss };
}
