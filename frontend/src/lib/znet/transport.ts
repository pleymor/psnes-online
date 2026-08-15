/**
 * Transport abstraction for netplay.
 *
 * The session only ever sees "send these bytes" and "here are some bytes".
 * That keeps the lockstep engine testable without a browser, a server, or a
 * network: the simulated transport below delivers the same byte stream through
 * a virtual clock with whatever latency, jitter and loss a test asks for.
 */

export interface Transport {
	send(data: Uint8Array): void;
	onMessage(handler: (data: Uint8Array) => void): void;
	close(): void;
	/** Round-trip time in ms, or null while unknown. */
	readonly rtt: number | null;
}

/* ------------------------------------------------------------ simulation */

export interface SimulatedLinkOptions {
	/** One-way latency in ms. */
	latency?: number;
	/** Uniform +/- jitter in ms applied to each packet's one-way latency. */
	jitter?: number;
	/** Fraction of packets dropped outright, 0..1. */
	loss?: number;
	/** Seed for the packet-scheduling RNG so a failing run replays exactly. */
	seed?: number;
}

interface InFlight {
	at: number;
	data: Uint8Array;
	seq: number;
}

/**
 * A deterministic pseudo-random generator.
 *
 * Test networks must be reproducible: a desync that only shows up under one
 * particular jitter pattern is useless if the pattern cannot be replayed.
 */
export class Rng {
	private state: number;

	constructor(seed = 0x2545f491) {
		this.state = seed >>> 0 || 1;
	}

	next(): number {
		let x = this.state;
		x ^= x << 13;
		x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5;
		x >>>= 0;
		this.state = x;
		return x / 0x100000000;
	}

	int(maxExclusive: number): number {
		return Math.floor(this.next() * maxExclusive);
	}
}

/**
 * A pair of simulated one-way links between two endpoints, driven by an
 * explicit virtual clock. Nothing is delivered until `advance()` is called,
 * so a whole netplay session runs as fast as the CPU allows and every test is
 * reproducible down to the packet.
 */
export class SimulatedLink {
	readonly a: SimulatedTransport;
	readonly b: SimulatedTransport;

	private now = 0;
	private rng: Rng;
	private opts: Required<SimulatedLinkOptions>;
	private seq = 0;

	/** Packets in flight, keyed by the endpoint that will receive them. */
	private queues = new Map<SimulatedTransport, InFlight[]>();

	stats = { sent: 0, delivered: 0, dropped: 0 };

	constructor(options: SimulatedLinkOptions = {}) {
		this.opts = {
			latency: options.latency ?? 30,
			jitter: options.jitter ?? 0,
			loss: options.loss ?? 0,
			seed: options.seed ?? 0x2545f491
		};
		this.rng = new Rng(this.opts.seed);
		this.a = new SimulatedTransport(this, 'a');
		this.b = new SimulatedTransport(this, 'b');
		this.queues.set(this.a, []);
		this.queues.set(this.b, []);
	}

	get time(): number {
		return this.now;
	}

	/** @internal */
	submit(from: SimulatedTransport, data: Uint8Array): void {
		const target = from === this.a ? this.b : this.a;
		this.stats.sent++;

		if (this.opts.loss > 0 && this.rng.next() < this.opts.loss) {
			this.stats.dropped++;
			return;
		}

		const jitter = this.opts.jitter > 0 ? (this.rng.next() * 2 - 1) * this.opts.jitter : 0;
		const delay = Math.max(0, this.opts.latency + jitter);

		this.queues.get(target)!.push({
			at: this.now + delay,
			// Copy: the caller is free to reuse its buffer once send() returns.
			data: data.slice(),
			seq: this.seq++
		});
	}

	/**
	 * Advance the virtual clock and deliver everything that has come due.
	 *
	 * Delivery is ordered by arrival time, then by send order. Jitter can
	 * therefore reorder packets, which is exactly the case a lockstep engine
	 * has to survive.
	 */
	advance(ms: number): void {
		this.now += ms;
		for (const [target, queue] of this.queues) {
			const due = queue.filter((p) => p.at <= this.now);
			if (due.length === 0) continue;
			this.queues.set(
				target,
				queue.filter((p) => p.at > this.now)
			);
			due.sort((x, y) => x.at - y.at || x.seq - y.seq);
			for (const packet of due) {
				this.stats.delivered++;
				target.deliver(packet.data);
			}
		}
	}

	setLatency(latency: number, jitter = this.opts.jitter): void {
		this.opts.latency = latency;
		this.opts.jitter = jitter;
	}

	setLoss(loss: number): void {
		this.opts.loss = loss;
	}
}

export class SimulatedTransport implements Transport {
	private handler: ((data: Uint8Array) => void) | null = null;
	private closed = false;

	constructor(
		private link: SimulatedLink,
		readonly name: string
	) {}

	get rtt(): number | null {
		return null; // The session measures RTT itself with ping/pong.
	}

	send(data: Uint8Array): void {
		if (this.closed) return;
		this.link.submit(this, data);
	}

	onMessage(handler: (data: Uint8Array) => void): void {
		this.handler = handler;
	}

	/** @internal */
	deliver(data: Uint8Array): void {
		if (this.closed) return;
		this.handler?.(data);
	}

	close(): void {
		this.closed = true;
	}
}
