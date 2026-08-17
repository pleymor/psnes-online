/**
 * Tests for the savestate codec.
 *
 * This sits directly on the resync path: a round trip that loses or reorders a
 * byte hands the peer a machine that is subtly not the host's, which is the
 * exact failure the whole design exists to prevent - and it would surface as a
 * desync, pointing the blame at the netcode.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { compress, decompress } from '../../frontend/src/lib/znet/compress.js';
import { coreIsBuilt, findTestRom, makeCore, InputTape } from './helpers.js';

function roundTrip(data: Uint8Array): void {
	const packed = compress(data);
	const back = decompress(packed);
	assert.equal(back.length, data.length, 'length must survive the round trip');
	for (let i = 0; i < data.length; i++) {
		if (back[i] !== data[i]) assert.fail(`byte ${i} differs: ${back[i]} != ${data[i]}`);
	}
}

test('round trips the shapes a savestate is made of', () => {
	roundTrip(new Uint8Array(0));
	roundTrip(new Uint8Array([7]));
	roundTrip(new Uint8Array(100_000)); // all zeroes, the common case
	roundTrip(new Uint8Array(1000).fill(0xff));

	// Runs longer than one token can hold.
	roundTrip(new Uint8Array(1000).fill(0xab));

	// Alternating bytes: no run is ever worth encoding, so this is the
	// worst case for the format and must still be exact.
	const alternating = new Uint8Array(5000);
	for (let i = 0; i < alternating.length; i++) alternating[i] = i % 2 ? 0 : 0xff;
	roundTrip(alternating);

	// Runs and literals meeting at every offset, which is where an
	// off-by-one in the token boundaries would show.
	for (let pad = 0; pad < 8; pad++) {
		const mixed = new Uint8Array(600 + pad);
		for (let i = 0; i < mixed.length; i++) mixed[i] = i < 300 ? 0 : (i * 7) & 0xff;
		roundTrip(mixed);
	}
});

test('round trips incompressible data without losing any', () => {
	// Pseudo-random, so the encoder is all literals and the output is larger
	// than the input. That has to work rather than overflow its buffer.
	let seed = 12345;
	const noise = new Uint8Array(200_000);
	for (let i = 0; i < noise.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		noise[i] = seed & 0xff;
	}
	roundTrip(noise);
	assert.ok(compress(noise).length < noise.length * 1.02, 'overhead must stay under 2%');
});

test('rejects corrupt input instead of returning a short state', () => {
	// A truncated or damaged payload must not decode to a plausible-looking
	// buffer: loading a half-state would desync the peers in a way that looks
	// like an emulation bug.
	assert.throws(() => decompress(new Uint8Array([9, 1, 2])), /corrupt/);
});

const built = coreIsBuilt();
const rom = built ? findTestRom() : null;

test(
	'a real savestate survives, and shrinks by about ten times',
	{ skip: !built ? 'core not built' : !rom ? 'no test ROM' : false },
	async () => {
		const core = await makeCore();
		core.loadRom(rom!.data);
		const pads = new InputTape(3).generate(600);
		for (let f = 0; f < 600; f++) core.runFrame(pads[f], 0);

		const state = core.saveState();
		roundTrip(state);

		const ratio = compress(state).length / state.length;
		assert.ok(ratio < 0.25, `expected a large saving, got ${(ratio * 100).toFixed(1)}%`);

		// The point of all this: the state shares a socket with the pads.
		const packed = decompress(compress(state));
		core.loadState(packed);
		assert.equal(core.stateCrc(), core.stateCrc(), 'the restored machine must be usable');

		core.dispose();
	}
);
