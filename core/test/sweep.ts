/**
 * Measures what a given input-delay split actually costs, on the real core.
 *
 * The netcode suite answers "does it stay in sync". This answers the question a
 * player asks instead: does the picture hold steady. `stalledTicks` cannot say,
 * because in lockstep the follower waits by construction and its counter climbs
 * on a perfectly healthy link. What a player feels is a frame arriving late, so
 * that is what this counts: every executed frame is stamped with the virtual
 * clock, and a gap wider than 1.5 frame times is a hitch.
 *
 * Not a test - a measuring instrument, so it asserts nothing and prints instead.
 *
 *   npm run measure:splits             # conditions x splits
 *   npm run measure:splits -- --seeds  # one split pair over five networks
 *
 * It needs the built core and a ROM, the same way the wasm test suites do.
 */

import { NetplaySession } from '../../frontend/src/lib/znet/session.js';
import { SimulatedLink } from '../../frontend/src/lib/znet/transport.js';
import { coreIsBuilt, crc32, findTestRom, makeCore, InputTape } from './helpers.js';

const FPS = 60.0988;
const FRAME_MS = 1000 / FPS;
/** A gap this much wider than a frame is visible as a stutter. */
const HITCH = 1.5;

interface Peer {
	name: 'p1' | 'p2';
	session: NetplaySession;
	/** Virtual time at which each frame was executed. */
	stamps: number[];
	crcs: Map<number, number>;
}

interface Result {
	d1: number;
	d2: number;
	hitches1: number;
	hitches2: number;
	worstGap: number;
	fps1: number;
	fps2: number;
	stalls1: number;
	stalls2: number;
	diverged: number | null;
}

async function measure(
	rom: Uint8Array,
	latency: number,
	jitter: number,
	d1: number,
	d2: number,
	seed: number
): Promise<Result> {
	const link = new SimulatedLink({ latency, jitter, seed });
	let time = 0;

	const tape1 = new InputTape(0x1111).generate(20000);
	const tape2 = new InputTape(0x2222).generate(20000);

	const peers: Peer[] = [];
	for (const [index, name] of (['p1', 'p2'] as const).entries()) {
		const core = await makeCore();
		core.loadRom(rom);
		const tape = index === 0 ? tape1 : tape2;
		const peer: Peer = { name, session: null!, stamps: [], crcs: new Map() };
		peer.session = new NetplaySession({
			core,
			transport: index === 0 ? link.a : link.b,
			playerIndex: index,
			isHost: index === 0,
			romCrc: crc32(rom),
			// High enough that both sides agree on something workable before the
			// split under test is applied; raising a delay is the case that used
			// to punch a hole, so start above and come down.
			inputDelay: 10,
			readLocalInput: () => tape[peer.session.currentFrame + peer.session.inputDelay] ?? 0,
			onFrame: () => {
				peer.stamps.push(time);
				peer.crcs.set(peer.session.currentFrame - 1, core.wramCrc());
			}
		});
		peer.session.now = () => time;
		peers.push(peer);
	}

	const accumulator = new Map<Peer, number>(peers.map((p) => [p, 0]));

	const advance = (ms: number) => {
		const end = time + ms;
		while (time < end) {
			link.advance(1);
			time += 1;
			for (const peer of peers) {
				peer.session.pump();
				let acc = accumulator.get(peer)! + 1;
				// One attempt per due frame; a stall banks the time, capped the way
				// FrameGovernor caps it so a hiccup cannot become a sprint.
				while (acc >= FRAME_MS) {
					if (peer.session.tick() !== 'ran') break;
					acc -= FRAME_MS;
				}
				accumulator.set(peer, Math.min(acc, FRAME_MS * 8));
			}
		}
	};

	for (const peer of peers) peer.session.start();
	advance(4000);
	if (peers.some((p) => p.session.state !== 'running')) {
		throw new Error(`handshake failed: ${peers.map((p) => p.session.state).join(' ')}`);
	}

	peers[0].session.setInputDelay(d1);
	peers[1].session.setInputDelay(d2);
	advance(3000); // let the queues drain and the pipeline refill

	// Only now does the measurement start.
	const base = peers.map((p) => ({
		frames: p.stamps.length,
		stalls: p.session.getStats().stalledTicks
	}));
	const measureFrom = time;
	const WINDOW = 20_000;
	advance(WINDOW);

	const stats = peers.map((peer, i) => {
		const stamps = peer.stamps.slice(base[i].frames);
		let hitches = 0;
		let worst = 0;
		let previous = measureFrom;
		for (const at of stamps) {
			const gap = at - previous;
			if (gap > FRAME_MS * HITCH) hitches++;
			if (gap > worst) worst = gap;
			previous = at;
		}
		return {
			hitches,
			worst,
			fps: (stamps.length / WINDOW) * 1000,
			stalls: peer.session.getStats().stalledTicks - base[i].stalls
		};
	});

	let diverged: number | null = null;
	for (const frame of [...peers[0].crcs.keys()].sort((a, b) => a - b)) {
		if (!peers[1].crcs.has(frame)) continue;
		if (peers[0].crcs.get(frame) !== peers[1].crcs.get(frame)) {
			diverged = frame;
			break;
		}
	}

	for (const peer of peers) peer.session.close();

	return {
		d1,
		d2,
		hitches1: stats[0].hitches,
		hitches2: stats[1].hitches,
		worstGap: Math.max(stats[0].worst, stats[1].worst),
		fps1: stats[0].fps,
		fps2: stats[1].fps,
		stalls1: stats[0].stalls,
		stalls2: stats[1].stalls,
		diverged
	};
}

/* ------------------------------------------------------------------- main */

async function main(): Promise<void> {
if (!coreIsBuilt()) {
	console.error('core not built - run ./core/build.sh');
	process.exit(1);
}
const rom = findTestRom();
if (!rom) {
	console.error('no ROM found - set PSNES_TEST_ROM or drop one in backend/roms/');
	process.exit(1);
}
console.log(`ROM: ${rom.name}  (${(rom.data.length / 1024).toFixed(0)} KB)\n`);

// The core prints mapper chatter on load, once per instance. Silence it so the
// table stays readable; anything on stderr still gets through.
const realWrite = process.stdout.write.bind(process.stdout);
let muted = false;
process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
	if (muted && typeof chunk === 'string' && /^Map_|^\s*$/.test(chunk)) return true;
	return realWrite(chunk as string, ...rest);
}) as typeof process.stdout.write;
muted = true;

const CONDITIONS = [
	{ label: 'RTT 60ms, calm    (jitter 3)', latency: 30, jitter: 3 },
	{ label: 'RTT 60ms, nervous (jitter 12)', latency: 30, jitter: 12 },
	{ label: 'RTT 90ms, calm    (jitter 3)', latency: 45, jitter: 3 },
	{ label: 'RTT 90ms, nervous (jitter 20)', latency: 45, jitter: 20 }
];

/** Same seed for every split in a condition: the network must be the control. */
const SEED = 0x51e5;

/** A deliberately generous split, to separate structural lumpiness from cause. */
const BASELINE: [number, number] = [8, 8];

const SPLITS: Array<[number, number]> = [
	[1, 1],
	[2, 2],
	[1, 3],
	[3, 3],
	[1, 5],
	[2, 4],
	[4, 4],
	[1, 7]
];

if (process.argv.includes('--seeds')) {
	/*
	 * The claim this mode exists to check: at equal sum, does a lopsided split
	 * behave like an even one? One network per row is not enough to answer it,
	 * because a single seed can flatter either side.
	 */
	const latency = 30;
	const jitter = 12;
	const pairs: Array<[number, number]> = [
		[4, 4],
		[1, 7]
	];
	console.log(`RTT ${2 * latency}ms, jitter ${jitter}ms - same sum, even against lopsided\n`);
	console.log(`  seed      ${pairs.map(([a, b]) => `${a}/${b} late p1/p2  worst`).join('    ')}`);
	for (const seed of [0x51e5, 0xa11c, 0x7e3d, 0xc0de, 0x1234]) {
		const cells: string[] = [];
		for (const [d1, d2] of pairs) {
			const r = await measure(rom.data, latency, jitter, d1, d2, seed);
			cells.push(
				`${String(r.hitches1).padStart(5)}/${String(r.hitches2).padEnd(5)} ${r.worstGap
					.toFixed(0)
					.padStart(4)}ms`
			);
		}
		console.log(`  0x${seed.toString(16).padStart(5, '0')}  ${cells.join('    ')}`);
	}
	return;
}

for (const cond of CONDITIONS) {
	const need = (2 * cond.latency) / FRAME_MS;
	console.log(`--- ${cond.label} | budget ${need.toFixed(2)} frames shared ---`);
	console.log('  split  sum   p1 feels  late p1/p2   excess   worst   fps p1/p2   verdict');
	// The reference first: whatever lumpiness survives at 8/8 is the
	// leader/follower structure, not something a tighter split caused.
	const ref = await measure(rom.data, cond.latency, cond.jitter, ...BASELINE, SEED);
	const floor = Math.max(ref.hitches1, ref.hitches2);
	console.log(
		`  ref 8/8  late ${ref.hitches1}/${ref.hitches2}` +
			`  worst ${ref.worstGap.toFixed(0)}ms  <- structural floor`
	);
	for (const [d1, d2] of SPLITS) {
		const r = await measure(rom.data, cond.latency, cond.jitter, d1, d2, SEED);
		const covered = d1 + d2 >= need;
		// Only what exceeds the reference is attributable to the split.
		const excess = Math.max(0, Math.max(r.hitches1, r.hitches2) - floor);
		const verdict =
			r.diverged !== null ? 'DESYNC' : excess === 0 ? 'clean' : excess < 30 ? 'marginal' : 'stutters';
		console.log(
			`  ${String(d1).padStart(2)}/${String(d2).padEnd(2)}` +
				`  ${String(d1 + d2).padStart(4)}${covered ? ' ok' : ' <<'}` +
				`  ${(d1 * FRAME_MS).toFixed(0).padStart(6)}ms` +
				`  ${String(r.hitches1).padStart(5)}/${String(r.hitches2).padEnd(5)}` +
				`  ${String(excess).padStart(6)}` +
				`  ${r.worstGap.toFixed(0).padStart(5)}ms` +
				`  ${r.fps1.toFixed(1).padStart(5)}/${r.fps2.toFixed(1).padEnd(5)}` +
				`  ${verdict}`
		);
	}
	console.log('');
}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
