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
	port: {
		onmessage: ((e: { data: Int16Array | string }) => void) | null;
		postMessage(message: unknown): void;
		sent: { type?: string; frames?: number }[];
	};
	process(inputs: unknown, outputs: Float32Array[][]): boolean;
}

/** Instantiates the shipped worklet source in a scope that looks like one. */
function makeSink(rate: number): Sink {
	let Processor: new () => Sink;
	const registerProcessor = (_name: string, cls: new () => Sink) => {
		Processor = cls;
	};
	class AudioWorkletProcessor {
		port = {
			onmessage: null,
			sent: [] as unknown[],
			postMessage(message: unknown) {
				this.sent.push(message);
			}
		};
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
	 * `process()` decrements `queued` once per frame it consumes. A trim that
	 * then throws the head chunk away must subtract only what is LEFT of it,
	 * or everything already played is subtracted a second time - `queued` falls
	 * below the real backlog, the trim stops firing when it should, and the
	 * bound it enforces drifts open. That is what a player heard: the lag
	 * settled past two seconds against a bound of one.
	 *
	 * Asserted as an invariant rather than against a particular depth, so it
	 * cannot rot the next time the bound is retuned - which has already
	 * happened once, when the ceiling became a target.
	 */
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(128), new Float32Array(128)]];

	// Enough to put the backlog over the high mark and have it cut back.
	for (let i = 0; i < 10; i++) push(4800);

	// The sink plays a render quantum, so the head chunk is now partly spent.
	sink.process([], out);
	assert.ok(sink.offset > 0, 'the head chunk is partly played');

	// More audio, which trims again - across a head that is mid-chunk.
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

test('the sink reports how deep its queue is, so the delay can be attributed', () => {
	/*
	 * A constant offset between a machine's sound and its own picture has two
	 * possible halves, and they call for opposite answers: what the platform
	 * adds below the API - `outputLatency`, commonly 100-200ms on Android and
	 * beyond reach from a page - and what our own queue is holding, which is
	 * entirely ours to shorten.
	 *
	 * Only the worklet knows the second, so it has to say. Reported on a
	 * counter rather than every render quantum: at 128 frames a quantum that
	 * would be some 375 messages a second across the thread for a figure the
	 * telemetry reads once.
	 */
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(128), new Float32Array(128)]];

	push(RATE / 4); // a quarter second in hand
	for (let i = 0; i < 200; i++) sink.process([], out);

	const reports = sink.port.sent.filter((m) => m && m.type === 'depth');
	assert.ok(reports.length > 0, 'the queue depth must reach the main thread at all');

	const last = reports[reports.length - 1];
	assert.equal(
		last.frames,
		trueQueued(sink),
		`the report must be the queue, says ${last.frames}, holds ${trueQueued(sink)}`
	);
});

test('a queue that never starves is still brought back down to its target', () => {
	/*
	 * The ratchet #81 left behind. Its debt is only paid when the sink starves,
	 * and a deep queue never starves - so once the backlog is past the point of
	 * starving, nothing pulls it down again and every burst adds to it for good.
	 * Measured in production: 363ms held on one machine against 160 on the
	 * other, with the platform's own path accounting for only 44 and 50.
	 *
	 * "Sound and picture agree at first, then drift apart the longer you play"
	 * is exactly that shape.
	 *
	 * So the bound stops being a ceiling and becomes a target: past a high mark
	 * the backlog is cut back to it, which bounds the delay at something a
	 * fighting game can live with instead of at a second.
	 */
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(128), new Float32Array(128)]];

	// A producer a little ahead of the sink, and never behind it - so it never
	// starves, and the old debt mechanism never gets a chance to fire.
	for (let i = 0; i < 400; i++) {
		push(160);
		sink.process([], out); // consumes 128
	}

	const heldMs = (trueQueued(sink) / RATE) * 1000;
	assert.ok(
		heldMs <= 130,
		`the backlog must stay near its target, holds ${Math.round(heldMs)}ms`
	);
});

test('a long silence is a break in the stream, not a debt to repay', () => {
	/*
	 * A pause stops the emulator, so the sink starves for as long as the player
	 * leaves it paused - and the debt grows the whole time. On resume the debt
	 * is paid in dropped audio, so the first N seconds of play come back silent
	 * and then lurch into the middle of a sound. Reported from a real session:
	 * "I paused, resumed, and then nothing, then the sound came back all wrong."
	 *
	 * The debt exists to keep the stream anchored to the wall clock across the
	 * short starvations lockstep produces. Past a quarter second of continuous
	 * silence the listener has lost continuity anyway: that is a break in the
	 * stream, and resuming cleanly costs nothing more than resuming late.
	 *
	 * The same guard covers a backgrounded tab and any stall long enough that
	 * the audio behind it is worthless.
	 */
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(128), new Float32Array(128)]];

	// Playing normally, so the stream has started and debts are real.
	push(128 * 10);
	for (let i = 0; i < 10; i++) sink.process([], out);

	// Two seconds paused: no audio produced at all while the sink runs on.
	for (let i = 0; i < (RATE * 2) / 128; i++) sink.process([], out);

	// Play resumes. This audio is the first of the new stream and must be heard.
	push(4800);
	sink.process([], out);

	assert.equal(
		trueQueued(sink),
		4800 - 128,
		`resumed audio must survive a pause, ${trueQueued(sink)} frames left of 4800`
	);
});
