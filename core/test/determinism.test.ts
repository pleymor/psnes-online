/**
 * Determinism tests.
 *
 * Lockstep netplay is only correct if `run_frame` is a pure function of state
 * and pads. Everything else in this project is built on that assumption, so it
 * is checked directly rather than inferred from "the game looked fine".
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { optional } from './skip.js';
import { coreIsBuilt, findTestRom, makeCore, InputTape } from './helpers.js';

const built = coreIsBuilt();
const rom = built ? findTestRom() : null;

const needsCore = optional(built ? false : 'core not built - run ./core/build.sh');
const needsRom = optional(
	!built
		? 'core not built - run ./core/build.sh'
		: !rom
			? 'no test ROM found - set PSNES_TEST_ROM'
			: false
);

needsCore('the entropy shims replace host randomness', async () => {
	// The shims are the fix for snes9x seeding 128KB of work RAM from
	// srand(time(NULL)). If they ever stop being linked in, this fails long
	// before anyone notices a desync in a real game.
	const a = await makeCore();
	const b = await makeCore();

	const seqA = Array.from({ length: 16 }, () => a.raw._pn_debug_rand());
	const seqB = Array.from({ length: 16 }, () => b.raw._pn_debug_rand());

	assert.deepEqual(seqA, seqB, 'two fresh instances must produce the same rand() stream');
	assert.equal(a.raw._pn_debug_time(), b.raw._pn_debug_time(), 'time() must be frozen');
	assert.notEqual(seqA[0], seqA[1], 'rand() must still actually vary');

	a.raw._pn_debug_reset_entropy();
	const replay = Array.from({ length: 16 }, () => a.raw._pn_debug_rand());
	assert.deepEqual(replay, seqA, 'resetting entropy must replay the same stream');

	a.dispose();
	b.dispose();
});

needsRom('loading the same ROM twice yields identical machines', async () => {
	const a = await makeCore();
	const b = await makeCore();

	a.loadRom(rom!.data);
	b.loadRom(rom!.data);

	assert.equal(a.wramCrc(), b.wramCrc(), 'work RAM must match before the first frame');
	assert.equal(a.stateCrc(), b.stateCrc(), 'full state must match before the first frame');

	a.dispose();
	b.dispose();
});

needsRom('two instances fed the same pads stay bit-identical', async () => {
	const FRAMES = 1800; // ~30 emulated seconds

	const a = await makeCore();
	const b = await makeCore();
	a.loadRom(rom!.data);
	b.loadRom(rom!.data);

	const p1 = new InputTape(0xa11ce).generate(FRAMES);
	const p2 = new InputTape(0xb0b).generate(FRAMES);

	for (let f = 0; f < FRAMES; f++) {
		a.runFrame(p1[f], p2[f]);
		b.runFrame(p1[f], p2[f]);

		// Checking every frame rather than every N means a failure reports the
		// exact frame that diverged, which is the difference between a fixable
		// bug and a mystery.
		if (a.wramCrc() !== b.wramCrc()) {
			assert.fail(`work RAM diverged at frame ${f}`);
		}
	}

	assert.equal(a.stateCrc(), b.stateCrc(), `full state diverged after ${FRAMES} frames`);

	a.dispose();
	b.dispose();
});

needsRom('a savestate round-trip reproduces the same future', async () => {
	// This is what a resync does: load a state mid-session and keep going. If
	// the restored machine drifts from the original, resync would turn a
	// recoverable hiccup into a permanent desync.
	const LEAD = 600;
	const TAIL = 600;

	const core = await makeCore();
	core.loadRom(rom!.data);

	const p1 = new InputTape(0xfeed).generate(LEAD + TAIL);
	const p2 = new InputTape(0xf00d).generate(LEAD + TAIL);

	for (let f = 0; f < LEAD; f++) core.runFrame(p1[f], p2[f]);

	const snapshot = core.saveState();
	const snapshotCrc = core.stateCrc();

	const expected: number[] = [];
	for (let f = LEAD; f < LEAD + TAIL; f++) {
		core.runFrame(p1[f], p2[f]);
		expected.push(core.wramCrc());
	}
	const finalCrc = core.stateCrc();

	core.loadState(snapshot);
	assert.equal(core.stateCrc(), snapshotCrc, 'restoring a state must restore it exactly');

	for (let i = 0; i < TAIL; i++) {
		const f = LEAD + i;
		core.runFrame(p1[f], p2[f]);
		if (core.wramCrc() !== expected[i]) {
			assert.fail(`replay diverged ${i} frames after the restore (frame ${f})`);
		}
	}
	assert.equal(core.stateCrc(), finalCrc, 'replayed run must end in the same state');

	core.dispose();
});

needsRom('a state transferred between instances continues identically', async () => {
	// The initial handshake in one test: host runs ahead, ships its state, and
	// from then on both machines must agree frame for frame.
	const host = await makeCore();
	const guest = await makeCore();
	host.loadRom(rom!.data);
	guest.loadRom(rom!.data);

	const warmup = new InputTape(1).generate(300);
	for (let f = 0; f < warmup.length; f++) host.runFrame(warmup[f], 0);

	guest.loadState(host.saveState());
	assert.equal(guest.stateCrc(), host.stateCrc(), 'guest must land on the host state exactly');

	const p1 = new InputTape(7).generate(900);
	const p2 = new InputTape(9).generate(900);
	for (let f = 0; f < 900; f++) {
		host.runFrame(p1[f], p2[f]);
		guest.runFrame(p1[f], p2[f]);
		if (host.wramCrc() !== guest.wramCrc()) {
			assert.fail(`transferred state diverged ${f} frames after the handover`);
		}
	}

	host.dispose();
	guest.dispose();
});

needsRom('different pads actually change the state', async () => {
	// A determinism suite passes trivially if input is being ignored. This
	// pins down that the pads are really reaching the emulated controllers.
	const a = await makeCore();
	const b = await makeCore();
	a.loadRom(rom!.data);
	b.loadRom(rom!.data);

	const START = 1 << 3;
	let diverged = false;
	for (let f = 0; f < 600 && !diverged; f++) {
		a.runFrame(f > 120 ? START : 0, 0);
		b.runFrame(0, 0);
		if (a.wramCrc() !== b.wramCrc()) diverged = true;
	}

	assert.ok(diverged, 'holding START must eventually change work RAM');

	a.dispose();
	b.dispose();
});

needsRom('the core produces a real picture and real audio', async () => {
	// Guards the output path before anything opens a browser: a core that
	// emulates perfectly but hands back an empty framebuffer looks identical
	// to a broken canvas, and the netplay tests would not notice either.
	const core = await makeCore();
	core.loadRom(rom!.data);

	for (let f = 0; f < 600; f++) core.runFrame(0, 0);

	const frame = core.videoFrame();
	assert.ok(frame.width >= 256 && frame.height >= 224, `odd geometry ${frame.width}x${frame.height}`);
	assert.equal(frame.data.length, frame.width * frame.height * 4);

	let lit = 0;
	for (let i = 0; i < frame.data.length; i += 4) {
		if (frame.data[i] || frame.data[i + 1] || frame.data[i + 2]) lit++;
	}
	assert.ok(lit > frame.width * frame.height * 0.02, `frame is essentially blank (${lit} lit pixels)`);
	assert.equal(frame.data[3], 255, 'pixels must be fully opaque');

	const audio = core.audio();
	assert.ok(audio.length > 0, 'no audio samples produced');
	assert.equal(audio.length % 2, 0, 'audio must be interleaved stereo');
	assert.ok(
		core.sampleRate > 8000 && core.sampleRate < 96000,
		`implausible sample rate ${core.sampleRate}`
	);
	assert.ok(core.fps > 50 && core.fps < 70, `implausible frame rate ${core.fps}`);

	core.dispose();
});

needsRom('SRAM survives a savestate round-trip', async () => {
	// In-game saves live in SRAM, and a resync replaces the whole machine.
	// If SRAM were not part of the serialised state, a resync would silently
	// roll back the other player's save file.
	const core = await makeCore();
	core.loadRom(rom!.data);
	for (let f = 0; f < 300; f++) core.runFrame(0, 0);

	const size = core.raw._pn_sram_size();
	if (size <= 0) return; // this cartridge has no battery-backed RAM

	const ptr = core.raw._pn_sram();
	for (let i = 0; i < Math.min(size, 256); i++) core.raw.HEAPU8[ptr + i] = (i * 7) & 0xff;

	const state = core.saveState();
	for (let f = 0; f < 60; f++) core.runFrame(0, 0);
	core.loadState(state);

	const after = core.sram();
	for (let i = 0; i < Math.min(size, 256); i++) {
		assert.equal(after[i], (i * 7) & 0xff, `SRAM byte ${i} did not survive the round trip`);
	}
	core.dispose();
});
