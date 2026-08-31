/**
 * Netplay tests driving the real emulator.
 *
 * netcode.test.ts already proves the protocol and the scheduler against a toy
 * machine. This suite answers the remaining question: does snes9x itself stay
 * bit-identical for tens of thousands of frames when it is driven only through
 * the netplay engine? It needs the built core and a ROM, so it skips cleanly
 * when either is missing.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { optional } from './skip.js';
import { coreIsBuilt, crc32, findTestRom, makeCore, InputTape } from './helpers.js';
import { NetplayHarness } from './harness.js';

const built = coreIsBuilt();
const rom = built ? findTestRom() : null;
const needsRom = optional(
	!built
		? 'core not built - run ./core/build.sh'
		: !rom
			? 'no test ROM found - set PSNES_TEST_ROM'
			: false
);

function options(frames: number, extra: Record<string, unknown> = {}) {
	return {
		makeCore: async () => {
			const core = await makeCore();
			core.loadRom(rom!.data);
			return core;
		},
		romCrc: rom ? crc32(rom.data) : 0,
		hostInput: new InputTape(0x1111).generate(frames),
		guestInput: new InputTape(0x2222).generate(frames),
		...extra
	};
}

needsRom('a real session on a clean link stays bit-identical', async () => {
	const harness = await NetplayHarness.create(
		options(6000, { link: { latency: 25, jitter: 5, seed: 1 }, inputDelay: 3 })
	);
	harness.handshake();
	harness.run(60_000);

	assert.equal(harness.firstDivergence(), null, 'peers must agree on every compared frame');
	assert.ok(harness.comparedFrames > 2500, `only ran ${harness.comparedFrames} frames`);
	assert.equal(harness.host.session.getStats().desyncs, 0);
	assert.ok(harness.statesMatchWhenAligned(), 'full machine state must match');

	harness.dispose();
});

needsRom('a real session survives a hostile link', async () => {
	const harness = await NetplayHarness.create(
		options(6000, {
			link: { latency: 150, jitter: 60, loss: 0.05, seed: 0xbadbad },
			inputDelay: 12,
			padRedundancy: 10
		})
	);
	harness.handshake();
	harness.run(45_000);

	assert.equal(harness.firstDivergence(), null, 'lossy link must not cause divergence');
	assert.ok(harness.comparedFrames > 800, `only ran ${harness.comparedFrames} frames`);
	assert.equal(harness.host.session.getStats().desyncs, 0);

	harness.dispose();
});

needsRom('a real session recovers from a corrupted peer', async () => {
	const harness = await NetplayHarness.create(
		options(6000, { link: { latency: 30, jitter: 5, seed: 7 }, crcInterval: 30, inputDelay: 3 })
	);
	harness.handshake();
	harness.run(4_000);
	assert.equal(harness.firstDivergence(), null, 'must be in sync before the sabotage');

	// Stand-in for any real divergence: scribble over the guest's work RAM.
	const guest = harness.guest.core as Awaited<ReturnType<typeof makeCore>>;
	const ramPtr = guest.raw._pn_wram();
	const heap = guest.raw.HEAPU8;
	for (let i = 0; i < 64; i++) heap[ramPtr + i * 97] ^= 0xff;
	assert.notEqual(guest.wramCrc(), harness.host.core.wramCrc());

	harness.clearLogs();
	harness.run(20_000);
	assert.ok(harness.host.session.getStats().resyncs > 0, 'host must ship a fresh state');

	harness.clearLogs();
	harness.run(20_000);
	assert.equal(harness.firstDivergence(), null, 'peers must agree again after recovery');
	assert.ok(harness.statesMatchWhenAligned(), 'full machine state must match after recovery');

	harness.dispose();
});
