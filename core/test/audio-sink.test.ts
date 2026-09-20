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

test('time spent playing silence is not paid back later as delay', () => {
	/*
	 * The root cause the cap was only ever bounding.
	 *
	 * Starved, `process()` writes silence and does NOT advance the queue. In
	 * lockstep the queue starves constantly - every wait on the peer's pad is a
	 * stretch where the emulator produces nothing while the wall clock runs on.
	 *
	 * When the peer catches up the emulator does not skip those frames: it runs
	 * them, and their audio is queued and played *later*. So the silence cost
	 * real time that consumed nothing, and everything after it is pushed back by
	 * exactly that much - permanently, and again at every stall. That is why the
	 * delay grows to the cap in about a minute and then sits there.
	 *
	 * The stream has to stay anchored to the wall clock: audio for a moment that
	 * has already been played as silence is stale, and dropping it trades a brief
	 * glitch for a delay that never comes back.
	 */
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(128), new Float32Array(128)]];

	// The session is playing normally first, so what follows is a stall and not
	// the silence before the first sound, which is owed nothing.
	push(128 * 10);
	for (let i = 0; i < 10; i++) sink.process([], out);
	assert.equal(trueQueued(sink), 0, 'drained exactly, nothing owed yet');

	// A quarter second of stall: the emulator is waiting on a pad and produces
	// nothing at all, while the sink plays on and has nothing to play.
	const quanta = Math.round(RATE / 4 / 128);
	for (let i = 0; i < quanta; i++) sink.process([], out);

	// The pad arrives. The emulator runs the frames it owed, audio and all - a
	// quarter second of it, belonging to a quarter second that is already spent.
	push(RATE / 4);
	sink.process([], out);

	assert.equal(
		trueQueued(sink),
		0,
		`audio for a moment already played as silence is stale, ${trueQueued(sink)} frames kept`
	);
});

test('silence before the first sound is not a debt', () => {
	/*
	 * The sink is connected and running before the emulator has produced
	 * anything: the context starts with the room, the first frame comes later.
	 * That silence is not owed audio - nothing was stalled, the game had simply
	 * not begun - so the first sound must play in full rather than be dropped
	 * as stale.
	 *
	 * The same holds after a flush, which is a deliberate restart of the
	 * stream: whatever was owed before it is not owed after.
	 */
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(128), new Float32Array(128)]];

	// Half a second of a running sink with nothing to play yet.
	for (let i = 0; i < RATE / 2 / 128; i++) sink.process([], out);

	push(4800);
	sink.process([], out);

	assert.equal(
		trueQueued(sink),
		4800 - 128,
		`the first sound must survive, ${trueQueued(sink)} frames left of 4800`
	);
});
