/**
 * The audio worklet's bookkeeping, driven as the browser drives it.
 *
 * The worklet ships as a source string evaluated inside an AudioWorklet scope,
 * so the only honest way to test it is to evaluate that same string here
 * against stubbed globals. Re-implementing its arithmetic in the test would be
 * the same maths written twice, and the two copies drift without saying so.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { WORKLET_SOURCE } from '../../frontend/src/lib/znet/output.js';

interface Sink {
	queue: Int16Array[];
	queued: number;
	offset: number;
	port: { onmessage: ((e: { data: Int16Array | string }) => void) | null };
	process(inputs: unknown, outputs: Float32Array[][]): boolean;
}

/** Instantiates the shipped worklet source in a scope that looks like one. */
function makeSink(rate: number): Sink {
	let Processor: new () => Sink;
	const registerProcessor = (_name: string, cls: new () => Sink) => {
		Processor = cls;
	};
	class AudioWorkletProcessor {
		port = { onmessage: null };
	}
	new Function(
		'AudioWorkletProcessor',
		'registerProcessor',
		'sampleRate',
		WORKLET_SOURCE
	)(AudioWorkletProcessor, registerProcessor, rate);
	return new Processor!();
}

/** `n` frames of interleaved stereo, the shape the core hands over. */
function chunk(frames: number): Int16Array {
	return new Int16Array(frames * 2);
}

/** What the queue actually holds, counted rather than remembered. */
function trueQueued(sink: Sink): number {
	let frames = 0;
	for (const c of sink.queue) frames += c.length / 2;
	return frames - sink.offset / 2;
}

const RATE = 48000;

test('dropping a partly played chunk does not discount the part already played', () => {
	/*
	 * The cap exists so a producer that outruns the sink cannot push the sound
	 * further behind the picture every second. It is expressed in samples, so
	 * it is one second of audio - and one second is already a great deal for a
	 * fighting game, which is why it must at least hold.
	 *
	 * `process()` decrements `queued` once per frame it consumes. The purge
	 * then throws the head chunk away and subtracts its *whole* length, so
	 * everything already consumed from it is subtracted a second time. `queued`
	 * falls below the real backlog, the cap stops triggering when it should,
	 * and the delay drifts past the second it was meant to bound - which is
	 * what a player hears: the lag settled past two seconds, not at one.
	 */
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });

	// Exactly one second in ten equal chunks: at the cap, nothing dropped yet.
	for (let i = 0; i < 10; i++) push(4800);
	assert.equal(sink.queued, RATE, 'one second queued, and the cap not yet exceeded');

	// The sink plays a render quantum, so the head chunk is now partly spent.
	const out = [[new Float32Array(128), new Float32Array(128)]];
	sink.process([], out);
	assert.equal(sink.offset, 256, 'a quantum of stereo frames is 256 interleaved values');

	// One more chunk puts it over the cap and triggers the purge.
	push(4800);

	assert.equal(
		sink.queued,
		trueQueued(sink),
		`the bookkeeping must match the queue: says ${sink.queued}, holds ${trueQueued(sink)}`
	);
});

test('the cap still bounds the backlog to a second once the count is honest', () => {
	// The consequence the player actually hears. Feeding a producer that runs
	// ahead for a while must not settle above one second of audio.
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(128), new Float32Array(128)]];

	// Twenty times more audio than is drained, which is what a catch-up burst
	// looks like from in here.
	for (let i = 0; i < 200; i++) {
		push(2560);
		sink.process([], out);
	}

	assert.ok(
		trueQueued(sink) <= RATE,
		`the backlog must stay within a second, holds ${trueQueued(sink)} frames`
	);
});
