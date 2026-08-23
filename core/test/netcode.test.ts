/**
 * Netcode tests that need no emulator.
 *
 * These run against FakeCore, so they exercise the wire format, the lockstep
 * scheduler, the epoch rules and the resync path in milliseconds. Anything
 * that can be proven here should be proven here rather than in the (much
 * slower, ROM-dependent) wasm suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	MsgType,
	PAD,
	PROTOCOL_VERSION,
	decode,
	encode,
	type NetMsg
} from '../../frontend/src/lib/znet/protocol.js';
import {
	NetplaySession,
	suggestInputDelay,
	type SessionEvent
} from '../../frontend/src/lib/znet/session.js';
import { SimulatedLink, type Transport } from '../../frontend/src/lib/znet/transport.js';
import { LagTransport, parseLag } from '../../frontend/src/lib/znet/lag-transport.js';
import { FakeCore } from './fake-core.js';
import { NetplayHarness } from './harness.js';
import { InputTape } from './helpers.js';

const ROM_CRC = 0xc0ffee;

function harnessOptions(frames: number, extra: Record<string, unknown> = {}) {
	return {
		makeCore: () => new FakeCore(),
		romCrc: ROM_CRC,
		hostInput: new InputTape(0x1111).generate(frames),
		guestInput: new InputTape(0x2222).generate(frames),
		...extra
	};
}

test('strain is reported, and a calm link reports none', async () => {
	// The loop's own input has to be visible, in the stats and in the shipped
	// telemetry: a loop whose input cannot be read in production is
	// indistinguishable from a loop that is broken, which is exactly the position
	// a real session left me in.
	const calm = await NetplayHarness.create(
		harnessOptions(8000, { link: { latency: 20, jitter: 2, seed: 94 }, inputDelay: 6 })
	);
	calm.handshake();
	calm.run(10_000);
	const quiet = calm.host.session.getStats();
	assert.equal(quiet.strain, 0, `a calm link with room must lose no frames, got ${quiet.strain}`);
	assert.equal(quiet.peerStrain, 0, 'and the peer must report none either');
	calm.dispose();

	// A split far too tight for the link has to show up as late frames on at
	// least one side, or the number is measuring nothing.
	const tight = await NetplayHarness.create(
		harnessOptions(8000, { link: { latency: 45, jitter: 20, seed: 95 }, inputDelay: 1 })
	);
	tight.handshake();
	tight.run(12_000);
	const hurt = tight.host.session.getStats();
	assert.ok(
		hurt.strain > 0 || hurt.peerStrain > 0,
		`a starved pair must report strain: ours ${hurt.strain}, theirs ${hurt.peerStrain}`
	);
	tight.dispose();
});

/* ------------------------------------------------------ feeding the peer */

test('raising the delay leaves no hole in our own pads, at any phase', async () => {
	// The wedge this exists to prevent, found in production and reproduced here.
	// A raise arrives between ticks, and `tick()` samples before it runs, so the
	// newest pad we hold targets `(frame - 1) + previous` - one lower than it
	// looks. Filling from one frame too high left exactly one hole, at the very
	// frame the peer needed first: thirteen flawless seconds at 50fps, then both
	// peers frozen for good on the first step the loop took.
	//
	// Twelve phases because a single one hides it: the hole only matters when the
	// raise lands before this tick has sampled, and where that falls depends on
	// how the jitter happened to space the packets.
	for (let seed = 1; seed <= 12; seed++) {
		const harness = await NetplayHarness.create(
			harnessOptions(20000, { link: { latency: 31, jitter: 12, seed }, inputDelay: 4 })
		);
		harness.handshake(30_000);
		harness.run(600 + seed * 149);

		const host = harness.host.session as unknown as {
			setDelay(n: number): void;
			pads: Array<Map<number, number>>;
			frame: number;
			playerIndex: number;
		};
		host.setDelay(5);

		const mine = host.pads[host.playerIndex];
		const missing: number[] = [];
		for (let f = host.frame; f <= host.frame + 5; f++) if (!mine.has(f)) missing.push(f);
		assert.deepEqual(missing, [], `hole in our own pads at seed ${seed}`);

		const before = harness.host.session.getStats().framesRun;
		harness.run(4_000);
		const ran = harness.host.session.getStats().framesRun - before;
		assert.ok(ran > 100, `wedged after the raise at seed ${seed}: ran ${ran}`);
		assert.equal(harness.firstDivergence(), null, `diverged at seed ${seed}`);
		harness.dispose();
	}
});

test('a peer losing frames gets fed, and the feeding stops when it is fed', async () => {
	// What keeps a peer's frames on time is *our* delay arriving early enough,
	// and nothing the peer controls, so it reports and we act. Measured in
	// production: a peer holding zero frames of its partner's pads stalled 24
	// times a second, and its partner adding two frames took that to zero.
	//
	// The link matters here. A steady one with an adequate sum loses no frames
	// even when the follower stalls hundreds of times - that case is covered
	// below and must *not* trip this. It takes real jitter to hurt.
	const harness = await NetplayHarness.create(
		harnessOptions(20000, { link: { latency: 30, jitter: 12, seed: 91 }, hungerSeconds: 3 })
	);
	harness.handshake(30_000);
	harness.run(2_000);

	// setDelay, not setInputDelay: automatic sizing has to stay on, since
	// pinning by hand is exactly what must disable this.
	const host = harness.host.session as unknown as { setDelay(n: number): void };
	host.setDelay(1);
	harness.run(20_000);

	const fed = harness.host.session.inputDelay;
	assert.ok(fed > 1, `the host must feed a peer losing frames: still ${fed}`);
	assert.equal(harness.firstDivergence(), null, 'feeding the peer must not desync');
	assert.equal(harness.host.session.state, 'running');

	// And it has to settle rather than climb to the ceiling: each step demands
	// twice the evidence, so a link needing four frames does not reach sixteen.
	harness.run(30_000);
	assert.ok(
		harness.host.session.inputDelay <= fed + 2,
		`the delay must settle, not creep: ${fed} -> ${harness.host.session.inputDelay}`
	);
	harness.dispose();
});

test('one rough patch costs nothing; a link that keeps misbehaving costs a frame', async () => {
	// The whole point of counting seconds instead of packets. Packets arrive fifty
	// times a second, so a single three-second burst used to supply well over a
	// hundred consecutive hungry ones and buy a frame on its own - permanently.
	// On the real link that mattered: strain sat at zero for 96% of a session and
	// spiked on a handful of isolated seconds.
	const burst = async (times: number) => {
		const harness = await NetplayHarness.create(
			harnessOptions(30000, { link: { latency: 22, jitter: 2, seed: 96 }, hungerSeconds: 10 })
		);
		harness.handshake(30_000);
		harness.run(3_000);
		const sized = harness.host.session.inputDelay;

		for (let i = 0; i < times; i++) {
			harness.link.setLatency(140, 40); // three seconds of real trouble
			harness.run(3_000);
			harness.link.setLatency(22, 2);
			harness.run(4_000);
		}
		// Long enough afterwards for a window's worth of quiet to pass.
		harness.run(35_000);
		const after = harness.host.session.inputDelay;
		harness.dispose();
		return { sized, after };
	};

	const once = await burst(1);
	// At most what it started with: one burst must not *raise*. Coming down
	// afterwards is correct - thirty quiet seconds is the descent's own signal.
	assert.ok(
		once.after <= once.sized,
		`one burst must not buy a frame: ${once.sized} -> ${once.after}`
	);

	const repeatedly = await burst(5);
	assert.ok(
		repeatedly.after > repeatedly.sized,
		`five bursts must: ${repeatedly.sized} -> ${repeatedly.after}`
	);
});

test('a link that recovers gets its frames back', async () => {
	// The ratchet used to be one-way, and on a link with a bad patch it climbed
	// and stayed there: a real session reached eight frames - 160ms - and had no
	// way down even after the link recovered. Going down needs the signal the
	// earlier attempts lacked: a full window with *no* strained second at all.
	const harness = await NetplayHarness.create(
		harnessOptions(40000, {
			link: { latency: 120, jitter: 30, seed: 97 },
			hungerSeconds: 4,
			inputDelay: 0
		})
	);
	harness.handshake(30_000);
	harness.run(40_000);
	const bad = harness.host.session.inputDelay;
	assert.ok(bad >= 6, `a 240ms link must have climbed: got ${bad}`);

	// The link becomes excellent. The frames bought for the bad patch are now
	// pure latency and have to come back.
	harness.link.setLatency(12, 2);
	harness.run(600_000);
	const good = harness.host.session.inputDelay;
	assert.ok(good < bad, `a recovered link must give frames back: ${bad} -> ${good}`);
	assert.ok(good >= 3, `but never below the automatic floor: got ${good}`);
	assert.equal(harness.firstDivergence(), null, 'coming down must not desync');
	harness.dispose();
});

test('the delay settles on a steady link instead of sawing', async () => {
	// Asymmetry is the whole of the hysteresis: a full clean window to give a
	// frame back, ten strained seconds to take one. On a link that is steadily
	// mediocre that has to converge rather than cycle for the whole match.
	const harness = await NetplayHarness.create(
		harnessOptions(40000, { link: { latency: 55, jitter: 14, seed: 98 }, hungerSeconds: 4 })
	);
	harness.handshake(30_000);
	harness.run(120_000);
	const settled = harness.host.session.inputDelay;
	harness.run(180_000);
	assert.equal(
		harness.host.session.inputDelay,
		settled,
		`the delay must settle, not saw: ${settled} -> ${harness.host.session.inputDelay}`
	);
	harness.dispose();
});

test('a fed peer never makes the delay creep', async () => {
	// The loop only ever raises, so a healthy session must not trip it at all;
	// otherwise every long match would drift to the ceiling.
	const harness = await NetplayHarness.create(
		harnessOptions(8000, { link: { latency: 15, jitter: 2, seed: 92 }, hungerSeconds: 3 })
	);
	harness.handshake(30_000);
	const sized = harness.host.session.inputDelay;
	harness.run(20_000);

	assert.equal(
		harness.host.session.inputDelay,
		sized,
		'a link with room to spare must be left alone'
	);
	harness.dispose();
});

test('a pinned delay is never raised behind the player\'s back', async () => {
	// Same contract the measurement already honours: a hand-set value is the
	// escape hatch, and an escape hatch that moves on its own is not one.
	const harness = await NetplayHarness.create(
		harnessOptions(8000, { link: { latency: 45, jitter: 4, seed: 93 }, hungerSeconds: 3 })
	);
	harness.handshake(30_000);
	harness.host.session.setInputDelay(1);
	harness.run(15_000);

	assert.equal(harness.host.session.inputDelay, 1, 'the pinned value must survive a hungry peer');
	harness.dispose();
});

/* -------------------------------------------------------------- frame rate */

test('the estimator works in the frames the machine actually runs', () => {
	// A PAL cartridge runs at 50.007Hz, so its frame is 19.997ms rather than
	// 16.639ms. Sizing a delay in NTSC frames for a PAL game prices the wrong
	// unit: the same round trip needs fewer of the longer frames, and what the
	// player feels per frame is 20ms, not 17ms.
	const PAL = 50.006978908188586;
	assert.equal(suggestInputDelay([200, 200, 200, 200], PAL), 8);
	assert.equal(suggestInputDelay([200, 200, 200, 200], 60.0988), 9);
});

test('jitter is measured against the machine cadence, not an assumed one', async () => {
	// The estimate compares each pad packet's spacing with the spacing it was
	// sent at, which is one frame. Assume the NTSC frame on a PAL session and
	// every packet looks 3.36ms late, so a perfectly steady link reports that
	// as jitter for ever - which is exactly what a real PAL session reported.
	const PAL = 50.006978908188586;
	const reading = async (fps: number) => {
		const harness = await NetplayHarness.create(
			harnessOptions(6000, { link: { latency: 25, jitter: 0, seed: 90 }, inputDelay: 6, fps: PAL })
		);
		// The harness paces the peers at the cadence under test; the session is
		// told the same number only in the second case.
		harness.handshake();
		harness.run(8_000, { fps });
		const value = harness.host.session.getStats().jitter;
		harness.dispose();
		return value;
	};

	const told = await reading(PAL);
	assert.ok(told !== null, 'a running session must produce a reading');
	assert.ok(
		told! < 2,
		`a jitter-free link told the truth about its cadence must read near zero, got ${told!.toFixed(2)}ms`
	);
});

/* ------------------------------------------------------------------- jitter */

test('the reported jitter tells a calm link from a nervous one', async () => {
	// Jitter, not latency, is what forces the input delay up: holding the round
	// trip at 60ms and moving jitter from 3ms to 12ms more than doubles the delay
	// the pair needs. So it has to be on screen next to the round trip, and it
	// cannot come from the ping - one sample every two seconds says nothing about
	// variation at frame scale. Pad packets arrive sixty times a second, and
	// their spacing is the measurement.
	const reading = async (jitter: number) => {
		const harness = await NetplayHarness.create(
			harnessOptions(6000, { link: { latency: 30, jitter, seed: 88 }, inputDelay: 6 })
		);
		harness.handshake();
		harness.run(8_000);
		const value = harness.host.session.getStats().jitter;
		harness.dispose();
		return value;
	};

	const calm = await reading(2);
	const nervous = await reading(20);

	assert.ok(calm !== null, 'a running session must produce a reading');
	assert.ok(nervous !== null);
	assert.ok(calm! < 6, `a 2ms link must read low, got ${calm!.toFixed(1)}ms`);
	assert.ok(
		nervous! > calm! * 2,
		`a 20ms link must read far higher: calm=${calm!.toFixed(1)} nervous=${nervous!.toFixed(1)}`
	);
});

test('jitter is unknown until pads are actually flowing', async () => {
	// Reporting zero before anything has arrived would read as a perfect link,
	// which is the one number a player should never be shown for free.
	const harness = await NetplayHarness.create(
		harnessOptions(2000, { link: { latency: 30, seed: 89 }, inputDelay: 4 })
	);
	assert.equal(harness.host.session.getStats().jitter, null, 'nothing measured yet');
	harness.handshake();
	harness.run(4_000);
	assert.notEqual(harness.host.session.getStats().jitter, null, 'and known once it runs');
	harness.dispose();
});

/* ------------------------------------------------------- simulated distance */

/** A schedule/cancel pair on a clock the test drives by hand. */
function fakeClock() {
	let now = 0;
	let next = 1;
	const due = new Map<number, { at: number; fn: () => void }>();
	return {
		schedule: (fn: () => void, ms: number) => {
			const id = next++;
			due.set(id, { at: now + ms, fn });
			return id;
		},
		cancel: (handle: unknown) => due.delete(handle as number),
		advance(ms: number) {
			now += ms;
			for (const [id, entry] of [...due].sort((a, b) => a[1].at - b[1].at)) {
				if (entry.at <= now) {
					due.delete(id);
					entry.fn();
				}
			}
		},
		get pending() {
			return due.size;
		}
	};
}

test('the lag simulator spends half the ping on each one-way hop', () => {
	// Half each way on purpose. A pad really travels `me -> relay -> peer`, so
	// its trip costs my half plus my partner's half; each side injecting its own
	// half on both send and receive reproduces exactly that, and makes the round
	// trip the session measures come out at ping_a + ping_b.
	const clock = fakeClock();
	const sent: Uint8Array[] = [];
	const got: Uint8Array[] = [];
	const inner: Transport = {
		send: (d) => sent.push(d),
		onMessage: () => {},
		close: () => {},
		rtt: null
	};
	const lag = new LagTransport(inner, { pingMs: 40, ...clock });
	lag.onMessage((d) => got.push(d));

	lag.send(new Uint8Array([1, 2, 3]));
	clock.advance(19);
	assert.equal(sent.length, 0, 'nothing may leave before the trip is over');
	clock.advance(2);
	assert.deepEqual([...sent[0]], [1, 2, 3], 'and it must leave intact at 20ms');
});

test('the lag simulator copies before it defers', () => {
	// The session reuses its encode buffers. Holding the caller's view for 20ms
	// and sending it later would put whatever the next packet wrote on the wire.
	const clock = fakeClock();
	const sent: Uint8Array[] = [];
	const lag = new LagTransport(
		{ send: (d) => sent.push(d), onMessage: () => {}, close: () => {}, rtt: null },
		{ pingMs: 40, ...clock }
	);
	const buffer = new Uint8Array([7, 7, 7]);
	lag.send(buffer);
	buffer.fill(9);
	clock.advance(50);
	assert.deepEqual([...sent[0]], [7, 7, 7]);
});

test('closing the lag simulator cancels what is still in flight', () => {
	// A delivery that fires after teardown calls a handler whose session is
	// gone. In a browser that surfaces as an exception from a room the player
	// already left, with nothing to connect it to.
	const clock = fakeClock();
	let delivered = 0;
	let innerClosed = false;
	let deliver: (d: Uint8Array) => void = () => {};
	const lag = new LagTransport(
		{
			send: () => {},
			onMessage: (h) => {
				deliver = h;
			},
			close: () => {
				innerClosed = true;
			},
			rtt: null
		},
		{ pingMs: 60, ...clock }
	);
	lag.onMessage(() => delivered++);

	deliver(new Uint8Array([1]));
	lag.send(new Uint8Array([2]));
	assert.equal(clock.pending, 2, 'both hops should be waiting');

	lag.close();
	assert.equal(clock.pending, 0, 'close must cancel them, not just ignore them');
	clock.advance(1000);
	assert.equal(delivered, 0);
	assert.equal(innerClosed, true, 'and the wrapped transport must still be closed');
});

test('the lag simulator drops the share of packets it was asked to', () => {
	const clock = fakeClock();
	let arrived = 0;
	const lag = new LagTransport(
		{ send: () => arrived++, onMessage: () => {}, close: () => {}, rtt: null },
		{ pingMs: 40, loss: 0.25, seed: 99, ...clock }
	);
	for (let i = 0; i < 400; i++) lag.send(new Uint8Array([i & 0xff]));
	clock.advance(100);
	// Reproducible from the seed, so a session that misbehaved can be replayed.
	assert.ok(arrived > 260 && arrived < 340, `expected roughly 300 of 400, got ${arrived}`);
});

test('a malformed lag parameter leaves the session on the real link', () => {
	// Silently running on a different link than you think is worse than the
	// parameter not working at all.
	assert.equal(parseLag(null), null);
	assert.equal(parseLag(''), null);
	assert.equal(parseLag('soon'), null);
	assert.equal(parseLag('-5'), null);
	assert.equal(parseLag('0'), null, 'zero would be a no-op dressed as a setting');
	assert.equal(parseLag('40,8,2'), null, 'loss is a fraction, not a percentage');
	assert.equal(parseLag('40,8,0.02,1'), null);
	assert.deepEqual(parseLag('40'), { pingMs: 40, jitterMs: 0, loss: 0 });
	assert.deepEqual(parseLag(' 40 , 8 '), { pingMs: 40, jitterMs: 8, loss: 0 });
	assert.deepEqual(parseLag('40,8,0.02'), { pingMs: 40, jitterMs: 8, loss: 0.02 });
});

/* ------------------------------------------------------------- wire format */

test('every message survives a round trip', () => {
	const messages: NetMsg[] = [
		{ type: MsgType.Hello, protocol: 1, romCrc: 0xdeadbeef, playerIndex: 1, playerCount: 2 },
		{
			type: MsgType.Pads,
			playerIndex: 1,
			epoch: 3,
			baseFrame: 123456,
			strain: 7,
			pads: [0, PAD.A, 0x0fff]
		},
		{ type: MsgType.Crc, playerIndex: 0, epoch: 3, frame: 900, crc: 0xffffffff },
		{
			type: MsgType.State,
			epoch: 2,
			frame: 42,
			totalLength: 5,
			chunkIndex: 1,
			chunkCount: 4,
			inputDelay: 7,
			crcInterval: 600,
			compressed: true,
			payload: new Uint8Array([1, 2, 3])
		},
		{ type: MsgType.StateAck, epoch: 2, frame: 42 },
		{ type: MsgType.Desync, epoch: 2, frame: 77 },
		{ type: MsgType.Ping, id: 9 },
		{ type: MsgType.Pong, id: 9 }
	];

	for (const msg of messages) {
		const back = decode(encode(msg));
		assert.deepEqual(back, msg, `round trip failed for message type ${msg.type}`);
	}
});

test('truncated and unknown packets are rejected, not misread', () => {
	// A half-read pad packet applied as if it were whole is a silent desync,
	// so decode has to be strict rather than forgiving.
	const pads = encode({ type: MsgType.Pads, playerIndex: 0, epoch: 0, baseFrame: 1, pads: [1, 2, 3] });
	assert.equal(decode(pads.subarray(0, pads.length - 1)), null);
	assert.equal(decode(new Uint8Array([0])), null);
	assert.equal(decode(new Uint8Array([250, 1, 2, 3])), null);
	assert.equal(decode(new Uint8Array(0)), null);
});

test('a pad packet stays small enough never to fragment', () => {
	const packet = encode({
		type: MsgType.Pads,
		playerIndex: 0,
		epoch: 0,
		baseFrame: 100000,
		strain: 4,
		pads: new Array(10).fill(PAD.A)
	});
	assert.ok(packet.length <= 32, `pad packet is ${packet.length} bytes`);
});

/* ------------------------------------------------------ simulated network */

test('the simulated link is reproducible and can reorder', () => {
	const seen: string[][] = [];
	for (let run = 0; run < 2; run++) {
		const link = new SimulatedLink({ latency: 50, jitter: 40, loss: 0.2, seed: 99 });
		const got: string[] = [];
		link.b.onMessage((d) => got.push(String(d[0])));
		for (let i = 0; i < 40; i++) {
			link.a.send(new Uint8Array([i]));
			link.advance(5);
		}
		link.advance(500);
		seen.push(got);
	}
	assert.deepEqual(seen[0], seen[1], 'the same seed must produce the same packet schedule');
	assert.ok(seen[0].length < 40, 'loss must actually drop packets');

	const ordered = seen[0].map(Number);
	const reordered = ordered.some((v, i) => i > 0 && v < ordered[i - 1]);
	assert.ok(reordered, 'jitter must be able to reorder packets');
});

/* -------------------------------------------------------------- handshake */

test('the host ships its state and both peers start at the same frame', async () => {
	const harness = await NetplayHarness.create(harnessOptions(500));
	harness.handshake();

	assert.equal(harness.host.session.state, 'running');
	assert.equal(harness.guest.session.state, 'running');
	assert.ok(harness.statesMatchWhenAligned(), 'both peers must be on the same machine state');

	harness.dispose();
});

test('a mismatched ROM is refused instead of desyncing later', async () => {
	const link = new SimulatedLink({ latency: 20 });
	const events: string[] = [];

	const { NetplaySession } = await import('../../frontend/src/lib/znet/session.js');
	const host = new NetplaySession({
		core: new FakeCore(),
		transport: link.a,
		playerIndex: 0,
		isHost: true,
		romCrc: ROM_CRC,
		readLocalInput: () => 0,
		onEvent: (e) => e.type === 'error' && events.push(e.message ?? '')
	});
	const guest = new NetplaySession({
		core: new FakeCore(),
		transport: link.b,
		playerIndex: 1,
		isHost: false,
		romCrc: ROM_CRC ^ 0xff,
		readLocalInput: () => 0,
		onEvent: (e) => e.type === 'error' && events.push(e.message ?? '')
	});

	host.start();
	guest.start();
	for (let i = 0; i < 200; i++) link.advance(5);

	assert.ok(
		events.some((m) => /ROM mismatch/.test(m)),
		'both peers must reject the session'
	);
	assert.notEqual(host.state, 'running');
	assert.notEqual(guest.state, 'running');
});

/* --------------------------------------------------------------- lockstep */

test('a clean link stays in sync', async () => {
	const harness = await NetplayHarness.create(
		harnessOptions(6000, { link: { latency: 25, jitter: 5, seed: 1 }, inputDelay: 3 })
	);
	harness.handshake();
	harness.run(60_000);

	assert.equal(harness.firstDivergence(), null);
	assert.ok(harness.comparedFrames > 3000, `only ran ${harness.comparedFrames} frames`);
	assert.equal(harness.host.session.getStats().desyncs, 0);
	harness.dispose();
});

test('a lossy, jittery, high-latency link stays in sync', async () => {
	// 150ms each way, 60ms jitter (so packets reorder) and 5% loss. There is no
	// retransmit for pads; the redundancy in each packet is what has to carry
	// this, and if it does not, frames get applied with the wrong input.
	const harness = await NetplayHarness.create(
		harnessOptions(6000, {
			link: { latency: 150, jitter: 60, loss: 0.05, seed: 0xbadbad },
			inputDelay: 12,
			padRedundancy: 10
		})
	);
	harness.handshake();
	harness.run(45_000);

	assert.equal(harness.firstDivergence(), null, 'packet loss must not corrupt the input tape');
	assert.ok(harness.comparedFrames > 1000, `only ran ${harness.comparedFrames} frames`);
	assert.equal(
		harness.host.session.getStats().desyncs,
		0,
		'loss must never be mistaken for a desync'
	);
	harness.dispose();
});

test('heavy loss degrades progress but never correctness', async () => {
	// 25% loss is well past playable. The session should crawl - and still be
	// bit-identical on every frame it does manage to run.
	const harness = await NetplayHarness.create(
		harnessOptions(6000, {
			link: { latency: 100, jitter: 30, loss: 0.25, seed: 0x5150 },
			inputDelay: 8,
			padRedundancy: 12
		})
	);
	harness.handshake(40_000);
	harness.run(30_000);

	assert.equal(harness.firstDivergence(), null);
	assert.ok(harness.comparedFrames > 0, 'session must make some progress');
	harness.dispose();
});

test('more input delay means fewer stalls', async () => {
	// The trade-off ZSNES exposes as a setting. Worth asserting: if raising the
	// delay stopped helping, the pad scheduling would be wrong.
	const stalls: Record<number, number> = {};
	for (const inputDelay of [1, 10]) {
		const harness = await NetplayHarness.create(
			harnessOptions(4000, { link: { latency: 80, jitter: 10, seed: 42 }, inputDelay })
		);
		harness.handshake();
		harness.run(20_000);
		assert.equal(harness.firstDivergence(), null, `divergence at delay=${inputDelay}`);
		stalls[inputDelay] = harness.host.session.getStats().stalledTicks;
		harness.dispose();
	}
	assert.ok(stalls[10] < stalls[1], `expected fewer stalls at higher delay, got ${JSON.stringify(stalls)}`);
});

test('both peers run the identical input tape', async () => {
	// The end-to-end property that matters: peer A's view of what peer B
	// pressed, frame by frame, must equal what B actually pressed.
	const harness = await NetplayHarness.create(
		harnessOptions(3000, { link: { latency: 90, jitter: 40, loss: 0.03, seed: 5 }, inputDelay: 8 })
	);
	harness.handshake();
	harness.run(30_000);

	const hostFrames = [...harness.host.crcLog.keys()].sort((a, b) => a - b);
	const guestFrames = [...harness.guest.crcLog.keys()].sort((a, b) => a - b);
	const overlap = hostFrames.filter((f) => harness.guest.crcLog.has(f));

	assert.ok(overlap.length > 500, 'peers must overlap on a meaningful number of frames');
	assert.ok(
		Math.abs(hostFrames.length - guestFrames.length) < 200,
		'neither peer may run away from the other'
	);
	assert.equal(harness.firstDivergence(), null);
	harness.dispose();
});

/* ----------------------------------------------------------------- resync */

test('a corrupted peer is detected and resynchronised', async () => {
	const harness = await NetplayHarness.create(
		harnessOptions(6000, { link: { latency: 30, jitter: 5, seed: 7 }, crcInterval: 30, inputDelay: 3 })
	);
	harness.handshake();
	harness.run(3_000);
	assert.equal(harness.firstDivergence(), null, 'must be in sync before the sabotage');

	(harness.guest.core as FakeCore).corrupt();
	assert.notEqual(
		harness.guest.core.wramCrc(),
		harness.host.core.wramCrc(),
		'sabotage must really change the machine'
	);

	harness.clearLogs();
	harness.run(15_000);

	const stats = harness.host.session.getStats();
	assert.ok(stats.desyncs > 0, 'the checksum exchange must notice');
	assert.ok(stats.resyncs > 0, 'the host must ship a fresh state');

	harness.clearLogs();
	harness.run(15_000);

	assert.equal(harness.firstDivergence(), null, 'peers must agree again after recovery');
	assert.ok(harness.comparedFrames > 300, 'the session must keep running after recovery');
	assert.ok(harness.statesMatchWhenAligned(), 'full machine state must match after recovery');
	harness.dispose();
});

test('a guest that spots the desync first also gets a resync', async () => {
	const harness = await NetplayHarness.create(
		harnessOptions(6000, { link: { latency: 30, seed: 11 }, crcInterval: 30, inputDelay: 3 })
	);
	harness.handshake();
	harness.run(2_000);

	// Corrupt the host: now the guest is the one whose checksum disagrees, and
	// it has to ask the host to re-authoritatively state the world.
	(harness.host.core as FakeCore).corrupt();
	harness.clearLogs();
	harness.run(20_000);

	assert.ok(harness.host.session.getStats().resyncs > 0, 'guest must be able to request a resync');
	harness.clearLogs();
	harness.run(10_000);
	assert.equal(harness.firstDivergence(), null);
	harness.dispose();
});

test('stale pads from before a resync are discarded', async () => {
	// The epoch counter exists for exactly this: on a long link, pads for the
	// old timeline are still in flight when the new state lands. Applying them
	// would re-corrupt the freshly synchronised machine.
	const harness = await NetplayHarness.create(
		harnessOptions(6000, {
			link: { latency: 200, jitter: 20, seed: 13 },
			crcInterval: 30,
			inputDelay: 15
		})
	);
	harness.handshake();
	harness.run(3_000);

	(harness.guest.core as FakeCore).corrupt();
	harness.clearLogs();
	harness.run(25_000);

	assert.ok(harness.host.session.getStats().resyncs > 0);
	harness.clearLogs();
	harness.run(15_000);
	assert.equal(harness.firstDivergence(), null, 'in-flight stale pads must not survive the resync');
	harness.dispose();
});

test('a dropped savestate chunk is retried instead of hanging the handshake', async () => {
	// 40% loss guarantees chunks go missing. Without the retry in pump(), the
	// guest sits on a half-assembled state forever and the session never starts.
	const harness = await NetplayHarness.create(
		harnessOptions(2000, {
			link: { latency: 40, jitter: 10, loss: 0.4, seed: 0xdead },
			inputDelay: 6,
			retryMs: 800
		})
	);
	harness.handshake(60_000);

	assert.equal(harness.host.session.state, 'running');
	assert.equal(harness.guest.session.state, 'running');

	harness.link.setLoss(0);
	harness.run(10_000);
	assert.equal(harness.firstDivergence(), null);
	harness.dispose();
});

/* ------------------------------------------------------------------- misc */

test('measured RTT tracks the link', async () => {
	const harness = await NetplayHarness.create(
		harnessOptions(500, { link: { latency: 75, jitter: 0, seed: 3 } })
	);
	harness.handshake();
	harness.run(10_000);

	const rtt = harness.host.session.rtt;
	assert.ok(rtt !== null, 'RTT must be measured');
	assert.ok(Math.abs(rtt! - 150) < 25, `expected ~150ms, got ${rtt}`);
	harness.dispose();
});

test('a peer that goes silent stalls rather than drifting', async () => {
	// The failure mode lockstep is supposed to have: no progress, but no
	// corruption either. Continuing on predicted input is what rollback does,
	// and it is explicitly not what this design promises.
	const harness = await NetplayHarness.create(
		harnessOptions(4000, { link: { latency: 30, seed: 17 }, inputDelay: 4 })
	);
	harness.handshake();
	harness.run(3_000);
	const frameBefore = harness.host.session.currentFrame;

	harness.link.setLoss(1);

	// It may legitimately consume the pads it already holds - up to the input
	// delay's worth, plus whatever frame-time was banked - so the number is not
	// the property worth pinning. What matters is that it comes to a stop and
	// stays stopped, rather than drifting ahead on invented input.
	harness.run(2_000);
	const afterFirstSecond = harness.host.session.currentFrame;
	harness.run(3_000);
	const frameAfter = harness.host.session.currentFrame;

	assert.equal(
		frameAfter,
		afterFirstSecond,
		`host kept advancing during the blackout (${afterFirstSecond} -> ${frameAfter})`
	);
	assert.ok(
		frameAfter - frameBefore < 30,
		`host ran too far into the blackout: ${frameAfter - frameBefore} frames`
	);

	harness.link.setLoss(0);
	harness.run(10_000);
	assert.ok(harness.host.session.currentFrame > frameAfter + 100, 'session must recover');
	assert.equal(harness.firstDivergence(), null);
	harness.dispose();
});

test('an outage recovers even when the redundancy window is shorter than the input delay', async () => {
	// The narrow case the stall re-send has to cover. A peer can sit up to
	// inputDelay+1 frames behind, so with delay 12 and only 4 frames of
	// redundancy per packet, the ordinary re-send window does not reach the
	// frame the peer is stuck on - and the session would deadlock forever
	// rather than resume when the link came back.
	const harness = await NetplayHarness.create(
		harnessOptions(6000, {
			link: { latency: 40, seed: 23 },
			inputDelay: 12,
			padRedundancy: 4
		})
	);
	harness.handshake();
	harness.run(4_000);
	const before = harness.host.session.currentFrame;
	assert.ok(before > 100, 'session must be running before the outage');

	harness.link.setLoss(1);
	harness.run(6_000);

	harness.link.setLoss(0);
	harness.run(10_000);

	assert.ok(
		harness.host.session.currentFrame > before + 200,
		`host stuck at frame ${harness.host.session.currentFrame} (was ${before})`
	);
	assert.ok(
		harness.guest.session.currentFrame > before + 200,
		`guest stuck at frame ${harness.guest.session.currentFrame} (was ${before})`
	);
	assert.equal(harness.firstDivergence(), null, 'recovery must not corrupt the input tape');
	harness.dispose();
});

test('a late duplicate state chunk does not knock a running guest back to syncing', async () => {
	// A multi-chunk savestate over a lossy, jittery link means the host
	// re-ships, the guest assembles from the second attempt, acks, starts
	// playing - and then stragglers from the first attempt arrive. Treating
	// those as the start of a new transfer parks the guest in 'syncing'
	// waiting for chunks the host has already stopped sending, forever.
	const harness = await NetplayHarness.create(
		harnessOptions(3000, {
			link: { latency: 120, jitter: 60, loss: 0.15, seed: 0x5747 },
			inputDelay: 8,
			retryMs: 400,
			stateChunkSize: 8
		})
	);

	harness.handshake(60_000);
	assert.equal(harness.guest.session.state, 'running');

	// Long enough for every straggler to land.
	harness.run(15_000);
	assert.equal(harness.guest.session.state, 'running', 'guest must stay in the session');
	assert.equal(harness.host.session.state, 'running');
	assert.ok(harness.comparedFrames > 200, `session stalled: ${harness.comparedFrames} frames`);
	assert.equal(harness.firstDivergence(), null);
	harness.dispose();
});

test('a peer that restarts mid-session rejoins instead of stranding the other', async () => {
	// What a page reload does: one side comes back as a brand new session at
	// frame 0 while the other is still running at frame N. Before this was
	// handled the survivor sat in 'running' forever, stalled on pads from a
	// timeline that no longer existed - an indefinite "waiting for the other
	// player" with no way out but reloading the other tab too.
	const { NetplaySession } = await import('../../frontend/src/lib/znet/session.js');

	const harness = await NetplayHarness.create(
		harnessOptions(6000, { link: { latency: 30, seed: 31 }, inputDelay: 4 })
	);
	harness.handshake();
	harness.run(4_000);

	const frameBefore = harness.host.session.currentFrame;
	assert.ok(frameBefore > 100, 'session must be underway before the reload');

	// The guest "reloads": its session is replaced by a fresh one on a fresh
	// core, exactly like a remounted component. The old session is abandoned
	// rather than closed - closing would tear down the simulated transport,
	// whereas a real reload comes back on a new socket.
	const revived = new FakeCore();
	const tape = new InputTape(0x2222).generate(6000);
	const guest = new NetplaySession({
		core: revived,
		transport: harness.link.b,
		playerIndex: 1,
		isHost: false,
		romCrc: ROM_CRC,
		inputDelay: 4,
		readLocalInput: () => tape[guest.currentFrame + 4] ?? 0,
		onFrame: (f) => harness.guest.crcLog.set(f - 1, revived.wramCrc())
	});
	guest.now = () => harness.time;
	harness.guest.session = guest;
	harness.guest.core = revived;
	harness.clearLogs();

	guest.start();
	harness.run(20_000);

	assert.equal(guest.state, 'running', 'the returning peer must get back in');
	assert.equal(harness.host.session.state, 'running', 'the survivor must not be stranded');
	assert.ok(
		harness.host.session.getStats().resyncs > 0,
		'the host must re-seed the returning peer from its own state'
	);
	assert.ok(
		harness.host.session.currentFrame > frameBefore + 200,
		'the session must keep advancing after the rejoin'
	);

	harness.clearLogs();
	harness.run(10_000);
	assert.equal(harness.firstDivergence(), null, 'both must agree again after the rejoin');
	assert.ok(harness.statesMatchWhenAligned(), 'and be on the same machine');

	harness.dispose();
});

test('a host never wedges forever waiting for an acknowledgement', async () => {
	// The failure mode behind "waiting for the other player" that never clears:
	// the host resyncs, the ack never comes back, and because a resyncing host
	// runs no frames it also sends no pads - so the peer waits on a player that
	// has stopped existing, with no way out but reloading both tabs.
	const harness = await NetplayHarness.create(
		harnessOptions(4000, { link: { latency: 30, seed: 77 }, inputDelay: 4, retryMs: 500 })
	);
	harness.handshake();
	harness.run(3_000);

	// Silence the guest completely, then force a resync it can never answer.
	harness.guest.session.close();
	harness.host.session.requestResync('test');
	harness.run(1_000);
	assert.equal(harness.host.session.state, 'resyncing', 'the host should be waiting at this point');

	harness.run(15_000);
	assert.notEqual(
		harness.host.session.state,
		'resyncing',
		'the host must give up rather than reship for ever'
	);

	harness.dispose();
});

test('a peer whose first HELLO is lost still gets into the session', async () => {
	// In production the two players joined the relay 1.9s apart, so the guest
	// announced itself into a channel the host had not entered yet and its
	// HELLO went nowhere. The host then announced itself, the guest heard it -
	// and stopped re-announcing, because the retry was guarded on "has the peer
	// said hello". The one peer that needed to keep talking was the one that
	// went quiet, and both sat in handshake for ever.
	const harness = await NetplayHarness.create(
		harnessOptions(2000, { link: { latency: 30, seed: 41 }, inputDelay: 4, retryMs: 500 })
	);

	// Guest speaks first, into the void.
	harness.link.setLoss(1);
	harness.guest.session.start();
	harness.run(1_000);

	// Host arrives on a working link.
	harness.link.setLoss(0);
	harness.host.session.start();
	harness.run(20_000, {
		stopWhen: () =>
			harness.host.session.state === 'running' && harness.guest.session.state === 'running'
	});

	assert.equal(harness.host.session.state, 'running', 'host must get past the handshake');
	assert.equal(harness.guest.session.state, 'running', 'guest must get past the handshake');

	harness.run(5_000);
	assert.equal(harness.firstDivergence(), null);
	harness.dispose();
});

test('a peer that goes permanently silent is reported, not waited on for ever', async () => {
	// What a lost seat looks like from the client: the session stays 'running'
	// and stalls on a pad that will never arrive. Indistinguishable from a
	// hiccup unless it says so.
	const harness = await NetplayHarness.create(
		harnessOptions(4000, { link: { latency: 30, seed: 61 }, inputDelay: 4 })
	);
	harness.handshake();
	harness.run(3_000);

	const reports: string[] = [];
	harness.host.session.close = harness.host.session.close; // keep the peer alive, just mute the link
	harness.host.events.length = 0;
	harness.link.setLoss(1);
	harness.run(30_000);

	for (const e of harness.host.events) if (e.type === 'link-lost') reports.push(e.message ?? '');
	assert.ok(
		reports.some((m) => /Lost contact/.test(m)),
		`expected a lost-contact report, got ${JSON.stringify(reports)}`
	);
	harness.dispose();
});

test('loading a savestate reseeds both peers instead of splitting them', async () => {
	// The whole point of routing a load through the epoch mechanism. Applied on
	// one side only, it is not a desync that drifts - the two machines simply
	// stop being the same machine from that instant.
	const harness = await NetplayHarness.create(
		harnessOptions(6000, { link: { latency: 40, seed: 91 }, inputDelay: 4, crcInterval: 30 })
	);
	harness.handshake();
	harness.run(3_000);

	// A snapshot of an earlier moment, as a save slot would hold.
	const snapshot = harness.host.core.saveState();
	harness.run(4_000);

	const epochBefore = harness.host.session.getStats().epoch;
	assert.ok(harness.host.session.loadAuthoritativeState(snapshot), 'the host must accept the load');
	harness.run(15_000);

	assert.notEqual(
		harness.host.session.getStats().epoch,
		epochBefore,
		'a load must open a new epoch, so in-flight pads are discarded'
	);
	assert.equal(harness.host.session.state, 'running');
	assert.equal(harness.guest.session.state, 'running');

	harness.clearLogs();
	harness.run(10_000);
	assert.equal(harness.firstDivergence(), null, 'both peers must be on the loaded machine');
	assert.ok(harness.statesMatchWhenAligned(), 'and agree byte for byte');
	assert.equal(harness.host.session.getStats().desyncs, 0, 'a load is not a desync');

	harness.dispose();
});

test('only the host can reseed the session', async () => {
	// Two peers each declaring a different authoritative state would race, and
	// the loser would be silently overwritten. The host owns the timeline, as
	// it does for every other resync.
	const harness = await NetplayHarness.create(
		harnessOptions(2000, { link: { latency: 30, seed: 92 }, inputDelay: 4 })
	);
	harness.handshake();
	harness.run(2_000);

	const snapshot = harness.guest.core.saveState();
	assert.equal(
		harness.guest.session.loadAuthoritativeState(snapshot),
		false,
		'a guest must not be able to reseed'
	);

	harness.run(3_000);
	assert.equal(harness.firstDivergence(), null);
	harness.dispose();
});

test('the host sizes the input delay from the link before shipping state', async () => {
	// The delay travels with the state and the guest adopts it there, so it has
	// to be right before the state goes out - and measuring afterwards is
	// useless anyway, since the transfer shares the socket with the pings and
	// inflates them.
	const slow = await NetplayHarness.create({
		makeCore: () => new FakeCore(),
		romCrc: ROM_CRC,
		hostInput: new InputTape(1).generate(3000),
		guestInput: new InputTape(2).generate(3000),
		link: { latency: 120, jitter: 5, seed: 71 } // 240ms round trip
	});
	slow.handshake(30_000);
	const slowDelay = slow.host.session.inputDelay;

	const fast = await NetplayHarness.create({
		makeCore: () => new FakeCore(),
		romCrc: ROM_CRC,
		hostInput: new InputTape(1).generate(3000),
		guestInput: new InputTape(2).generate(3000),
		link: { latency: 10, jitter: 2, seed: 72 } // 20ms round trip
	});
	fast.handshake(30_000);
	const fastDelay = fast.host.session.inputDelay;

	assert.ok(
		slowDelay > fastDelay,
		`a slower link must get more delay: slow=${slowDelay} fast=${fastDelay}`
	);
	assert.equal(
		slow.guest.session.inputDelay,
		slowDelay,
		'the guest must adopt the delay the state was sized with'
	);

	// And both sessions must actually run afterwards.
	slow.run(10_000);
	fast.run(10_000);
	assert.equal(slow.firstDivergence(), null);
	assert.equal(fast.firstDivergence(), null);

	slow.dispose();
	fast.dispose();
});

test('a pinned input delay is never overridden by the measurement', async () => {
	// The manual setting ZSNES exposes. If measurement could override it, the
	// only escape hatch on a link the formula reads wrongly would be gone.
	const harness = await NetplayHarness.create(
		harnessOptions(2000, { link: { latency: 150, seed: 73 }, inputDelay: 4 })
	);
	harness.handshake(30_000);

	assert.equal(harness.host.session.inputDelay, 4, 'the pinned value must survive');
	assert.equal(harness.guest.session.inputDelay, 4);
	harness.dispose();
});

/* ------------------------------------------------------- sizing the delay */

test('the delay estimator drops the warm-up outlier before measuring spread', () => {
	// The first round trip of a session carries the socket, the TLS handshake
	// and the relay's route cache all waking up. It is not the link, and a
	// session sized on it pays for a latency that never comes back. One
	// outlier is warm-up; two are a slow link, and those must still count.
	assert.equal(suggestInputDelay([400, 40, 41, 40, 42]), 4);
	assert.ok(
		suggestInputDelay([400, 400, 40, 41, 40]) > 4,
		'two slow samples are a slow link, not a warm-up'
	);
});

test('a clean link is sized more tightly than a jittery one', () => {
	// Same fastest sample in both, so only the spread can move the answer.
	const clean = suggestInputDelay([80, 80, 80, 80, 80]);
	const jittery = suggestInputDelay([80, 110, 140, 170, 200]);
	assert.ok(clean < jittery, `clean=${clean} jittery=${jittery}`);
	// Pinned rather than asserted as a direction: two frames of margin on a
	// clean link is the floor a production session proved it needs, and an
	// earlier version of this file tried to reclaim one of them and caused
	// twenty-four stalls a second. The spread only ever adds to that floor.
	assert.equal(clean, 5);
});

test('the estimator stays inside the bounds the priming window assumes', () => {
	assert.equal(suggestInputDelay([1, 1, 1]), 3, 'a LAN still gets the floor');
	assert.equal(suggestInputDelay([4000, 4000, 4000]), 16, 'a hopeless link is capped');
});

test('the two delays only have to cover the round trip between them', async () => {
	// The constraint is on the sum, not on each peer. Frame F on one side needs
	// the other's pad, emitted D frames earlier, so a steady 60fps requires
	// `guest_t(F) >= host_t(F - Dh) + L` and the mirror of it; adding the two
	// leaves `Dh + Dg >= RTT / frameMs`. Neither delay has to cover the one-way
	// trip on its own, which is what makes the budget transferable: a player who
	// cannot stand the lag can take the small half of it.
	const rttFrames = Math.ceil(200 / (1000 / 60.0988)); // 100ms each way
	const harness = await NetplayHarness.create(
		harnessOptions(20000, { link: { latency: 100, jitter: 2, seed: 86 }, inputDelay: 8 })
	);
	harness.handshake(30_000);

	// Three frames for one player and thirteen for the other: the small half is
	// well under the six frames the one-way trip alone would demand.
	harness.host.session.setInputDelay(3);
	harness.guest.session.setInputDelay(13);
	assert.ok(3 + 13 >= rttFrames, `the split must still cover the round trip`);

	const before = harness.host.session.getStats().framesRun;
	harness.run(10_000);
	const ran = harness.host.session.getStats().framesRun - before;

	// A split that covers the round trip runs at full speed; the latency shows
	// up as a one-off offset between the peers, not as lost frames.
	assert.ok(ran > 560, `expected close to 600 frames in 10s, ran ${ran}`);
	assert.equal(harness.firstDivergence(), null);
	harness.dispose();
});

test('one peer can sit under the automatic floor if its partner sits above', async () => {
	// The pay-off of the delay being a shared budget. On a 90ms round trip the
	// pair needs about 5.4 frames between them; a 1/5 split supplies six, so the
	// player on the short end feels one frame of lag - 17ms - where the even 3/3
	// split makes both feel three. Measured side by side, 1/5 stalls the leader
	// exactly as little as 3/3 does, and 2/3 (five frames, but short of the
	// requirement) stalls it thousands of times.
	const stalls: Record<string, number> = {};
	for (const [name, dh, dg] of [
		['even', 3, 3],
		['uneven', 1, 5]
	] as const) {
		const harness = await NetplayHarness.create(
			harnessOptions(6000, { link: { latency: 45, jitter: 3, seed: 87 }, inputDelay: 6 })
		);
		harness.handshake(30_000);
		harness.host.session.setInputDelay(dh);
		harness.guest.session.setInputDelay(dg);
		harness.run(2_000);

		// Measured after the split has settled: the frames right after a change
		// are still draining the old queue.
		const before = harness.host.session.getStats().stalledTicks;
		harness.clearLogs();
		harness.run(10_000);
		stalls[name] = harness.host.session.getStats().stalledTicks - before;

		assert.equal(harness.host.session.inputDelay, dh, 'the manual floor must allow one frame');
		assert.equal(harness.firstDivergence(), null, `${name} split diverged`);
		harness.dispose();
	}

	assert.equal(stalls.even, 0, `the even split is the control: ${stalls.even}`);
	assert.equal(
		stalls.uneven,
		0,
		`an uneven split covering the same budget must be just as clean: ${stalls.uneven}`
	);
});

test('peers stay bit-identical while holding different input delays', async () => {
	// The invariant the whole ratchet rests on: pads are keyed by absolute
	// frame, so past the startup priming window the delay governs nothing but
	// how far ahead a peer samples its own input. If that were wrong, two peers
	// stepping down at different moments would desync, and the ratchet would
	// need a synchronised switch and a protocol change to go with it.
	const harness = await NetplayHarness.create(
		harnessOptions(6000, { link: { latency: 30, jitter: 5, seed: 85 }, inputDelay: 8 })
	);
	harness.handshake();
	harness.run(3_000);
	harness.clearLogs();

	harness.host.session.setInputDelay(4);
	harness.run(6_000);

	assert.notEqual(
		harness.host.session.inputDelay,
		harness.guest.session.inputDelay,
		'the test proves nothing unless the two really differ'
	);
	assert.equal(harness.firstDivergence(), null);
	assert.ok(harness.comparedFrames > 200, `only ${harness.comparedFrames} frames were compared`);
	harness.dispose();
});

/* --------------------------------------------------------- link recovery */

test('a link that goes quiet is reported, and so is its return', async () => {
	const harness = await NetplayHarness.create(harnessOptions(6000));
	harness.handshake();
	harness.run(2000);

	// Total outage: every packet is dropped, so both peers stall on pads that
	// will never arrive. This is what a backend restart looks like from here.
	harness.link.setLoss(1);
	harness.run(20_000);

	assert.equal(
		harness.host.events.filter((e) => e.type === 'link-lost').length,
		1,
		'silence must be reported exactly once, not once per tick'
	);
	assert.equal(
		harness.host.events.some((e) => e.type === 'error'),
		false,
		'a recoverable outage must not arrive on the fatal channel'
	);
	assert.equal(harness.host.session.state, 'running', 'the session must not give up');

	const framesBefore = harness.host.session.getStats().framesRun;

	harness.link.setLoss(0);
	harness.run(10_000);

	assert.equal(
		harness.host.events.filter((e) => e.type === 'link-restored').length,
		1,
		'the return of the link must be reported'
	);
	assert.ok(
		harness.host.session.getStats().framesRun > framesBefore,
		'play must actually resume, not merely be reported as resumed'
	);
});

test('a fatal failure is never retracted', () => {
	// A ROM mismatch cannot be recovered from by construction: the two machines
	// could never agree on anything. Keeping it on a separate channel from
	// silence is the point of this change, so prove it stays terminal.
	const link = new SimulatedLink({ latency: 10 });
	const events: SessionEvent[] = [];

	const session = new NetplaySession({
		core: new FakeCore(),
		transport: link.a,
		playerIndex: 0,
		isHost: true,
		romCrc: ROM_CRC,
		readLocalInput: () => 0,
		onEvent: (e) => events.push(e),
		onFrame: () => {}
	});
	session.start();

	// The peer announces a different cartridge. link.b sends to link.a.
	link.b.send(
		encode({
			type: MsgType.Hello,
			protocol: PROTOCOL_VERSION,
			romCrc: ROM_CRC ^ 0xffff,
			playerIndex: 1,
			playerCount: 2
		})
	);
	link.advance(50);

	assert.equal(session.state, 'failed');
	assert.equal(events.filter((e) => e.type === 'error').length, 1, 'the mismatch must be fatal');
	assert.equal(
		events.some((e) => e.type === 'link-restored'),
		false,
		'a fatal error must never be followed by a recovery event'
	);
});

test('giving up on an unacknowledged state is reported as recoverable, and its recovery too', async () => {
	// The same "wedged forever" scaffolding as the test above, but this one
	// asks what travels on the wire rather than just what the state machine
	// does. The give-up used to be indistinguishable from a ROM mismatch: both
	// were 'error'. Silencing the link instead of closing the guest's session
	// keeps its transport alive, so the restarted handshake below can actually
	// be answered - proving the give-up did not just get reported, it healed.
	const harness = await NetplayHarness.create(
		harnessOptions(4000, { link: { latency: 30, seed: 79 }, inputDelay: 4, retryMs: 500 })
	);
	harness.handshake();
	harness.run(3_000);

	harness.link.setLoss(1);
	harness.host.session.requestResync('test');
	harness.run(5_000);

	assert.equal(
		harness.host.session.state,
		'handshake',
		'giving up must restart the handshake, not stay wedged in resyncing'
	);
	assert.equal(
		harness.host.events.filter((e) => e.type === 'link-lost').length,
		1,
		'the give-up must be reported exactly once'
	);
	assert.equal(
		harness.host.events.some((e) => e.type === 'error'),
		false,
		'a self-healing give-up must not arrive on the fatal channel'
	);

	const framesBefore = harness.host.session.getStats().framesRun;

	harness.link.setLoss(0);
	harness.run(10_000);

	assert.equal(
		harness.host.events.filter((e) => e.type === 'link-restored').length,
		1,
		'the restarted handshake succeeding must be reported'
	);
	assert.ok(
		harness.host.session.getStats().framesRun > framesBefore,
		'play must actually resume, not merely be reported as resumed'
	);

	harness.dispose();
});
