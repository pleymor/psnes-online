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
import { NetplaySession, type SessionEvent } from '../../frontend/src/lib/znet/session.js';
import { SimulatedLink } from '../../frontend/src/lib/znet/transport.js';
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

/* ------------------------------------------------------------- wire format */

test('every message survives a round trip', () => {
	const messages: NetMsg[] = [
		{ type: MsgType.Hello, protocol: 1, romCrc: 0xdeadbeef, playerIndex: 1, playerCount: 2 },
		{ type: MsgType.Pads, playerIndex: 1, epoch: 3, baseFrame: 123456, pads: [0, PAD.A, 0x0fff] },
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
