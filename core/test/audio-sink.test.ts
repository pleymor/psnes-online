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
		sent: { type?: string; frames?: number; dropped?: number }[];
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

	/*
	 * Down to the working target, not to nothing. Emptying it was the first
	 * version of this, and emptying it is what let the starvation feed itself -
	 * a queue with no buffer starves again immediately. What must not survive is
	 * the quarter second of stale audio; the target's worth is kept on purpose.
	 */
	const heldMs = (trueQueued(sink) / RATE) * 1000;
	assert.ok(
		heldMs < 60,
		`stale audio must not be kept, holds ${Math.round(heldMs)}ms of the 250 pushed`
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

test('a producer no playback speed could catch is still bounded, by cutting', () => {
	/*
	 * The safety net, and the one case where throwing audio away is still the
	 * right answer. Reading one percent faster drains the drift a real session
	 * shows; it cannot answer a producer running a quarter faster than the
	 * sink for ever - a fast-forward, a runaway catch-up - and no playback
	 * speed that stayed inaudible could.
	 *
	 * So the axe remains at a second, and here it is expected to fire. What
	 * this pins is that the backlog is bounded at all, which is what the cap
	 * has always been for.
	 */
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]];

	for (let i = 0; i < 4000; i++) {
		push(160); // against 128 consumed
		sink.process([], out);
	}

	const heldMs = (trueQueued(sink) / RATE) * 1000;
	assert.ok(heldMs <= 1050, `the backlog must stay bounded, holds ${Math.round(heldMs)}ms`);

	const reports = sink.port.sent.filter((m) => m && m.type === 'depth');
	assert.ok(
		(reports[reports.length - 1].dropped ?? 0) > 0,
		'and here, unlike the drainable case, cutting is what held it'
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

/** Frames the sink consumes at nominal speed for one render quantum. */
const QUANTUM = 128;

test('a backlog is drained by playing faster, without dropping a sample', () => {
	/*
	 * The three mechanisms that could shorten this queue all did it by throwing
	 * audio away, and every throw is a discontinuity - a click. The player heard
	 * them as light crackling, and three successive fixes only moved the noise
	 * around.
	 *
	 * Reading very slightly faster drains the same backlog with nothing
	 * discarded: half a percent of pitch is inaudible, and the latency
	 * converges towards the target instead of jumping to it. It is what
	 * emulator frontends have called dynamic rate control for twenty years.
	 *
	 * The axe stays, but only at a second - so a queue that comes down from
	 * 300ms to near the target here cannot have been cut. Nothing else could
	 * have done it.
	 */
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]];

	push(Math.round(RATE * 0.3)); // 300ms in hand, as measured in production

	// A producer four parts in a thousand ahead of the sink - the order of
	// drift a real session showed, and far too little to notice as pitch.
	let pushed = 0;
	for (let i = 1; i <= 20000; i++) {
		const want = Math.round(QUANTUM * 1.004 * i);
		if (want > pushed) {
			push(want - pushed);
			pushed = want;
		}
		sink.process([], out);
	}

	const heldMs = (trueQueued(sink) / RATE) * 1000;
	assert.ok(
		heldMs < 100,
		`the backlog must come down on its own, holds ${Math.round(heldMs)}ms`
	);

	// And the whole point: it came down without a sample being thrown away.
	// Asserting only the depth would pass on the axe, which is what this
	// replaces.
	const reports = sink.port.sent.filter((m) => m && m.type === 'depth');
	const dropped = reports[reports.length - 1].dropped;
	assert.equal(dropped, 0, `nothing may be discarded, ${dropped} frames were`);
});

test('a queue already at its target is left alone', () => {
	// Draining must not become its own drift. A producer exactly in step with
	// the sink should see the depth held, not walked down to nothing - an empty
	// queue is an underrun waiting to happen.
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]];

	push(Math.round(RATE * 0.05)); // start at the target
	for (let i = 0; i < 5000; i++) {
		push(QUANTUM);
		sink.process([], out);
	}

	const heldMs = (trueQueued(sink) / RATE) * 1000;
	assert.ok(heldMs > 30, `a queue in step must be kept, holds ${Math.round(heldMs)}ms`);
	assert.ok(heldMs < 80, `and not allowed to grow either, holds ${Math.round(heldMs)}ms`);
});

test('a sudden excursion is cut back at once, not drained for a minute', () => {
	/*
	 * Reported in play: the sound is perfect, then misbehaves the moment the
	 * window is minimised and restored, or fast-forward is used and released.
	 *
	 * Both put the producer far ahead in one go - fast-forward makes four times
	 * the audio the sink consumes, and a restored window resumes in a burst.
	 * The backlog lands at hundreds of milliseconds, and one percent of drain
	 * would need a hundred seconds to answer a second of it. Draining is right
	 * for drift and useless for an excursion.
	 *
	 * So both, with the cut placed where ordinary play never reaches it: the
	 * 120ms it used to sit at was inside the normal range, which is why it
	 * clicked constantly. Past 400ms nothing is ordinary any more, and a player
	 * who just released fast-forward will take one glitch over a sound that
	 * stays half a second late.
	 */
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]];

	// What a spell of fast-forward leaves behind.
	push(Math.round(RATE * 0.8));

	// A quarter second of ordinary playback afterwards.
	for (let i = 0; i < RATE / 4 / QUANTUM; i++) sink.process([], out);

	const heldMs = (trueQueued(sink) / RATE) * 1000;
	assert.ok(
		heldMs < 120,
		`an excursion must be answered at once, still holds ${Math.round(heldMs)}ms`
	);
});

test('a starving queue is never cut further to pay a debt', () => {
	/*
	 * The feedback loop, measured in production on 2026-09-22 after a window was
	 * minimised and restored: the emulator back at 60fps and drawing normally,
	 * the queue held at 6-23ms instead of a healthy 26-47, and `dropped`
	 * climbing 150 to 250ms every second without ever stopping.
	 *
	 * The queue never went near the excursion threshold, so only the starvation
	 * debt could be doing the cutting - and it sustains itself: the queue
	 * starves, the debt grows, the audio that arrives is thrown away to settle
	 * it, so the queue starves again. Nothing breaks the cycle.
	 *
	 * A debt is only payable out of surplus. Below the target there is none, and
	 * cutting there makes the starvation it is answering strictly worse.
	 */
	const sink = makeSink(RATE);
	const push = (frames: number) => sink.port.onmessage!({ data: chunk(frames) });
	const out = [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]];

	// Playing, so the stream has started and debts are real.
	push(QUANTUM * 10);
	for (let i = 0; i < 10; i++) sink.process([], out);

	/*
	 * A producer exactly in step, but arriving just after the sink asks - the
	 * order a restored window leaves behind. Every quantum starves, then is fed.
	 */
	const droppedAt = (n: number) => {
		for (let i = 0; i < n; i++) {
			sink.process([], out);
			push(QUANTUM);
		}
		const reports = sink.port.sent.filter((m) => m && m.type === 'depth');
		return reports[reports.length - 1].dropped ?? 0;
	};

	const early = droppedAt(1000);
	const late = droppedAt(1000);

	assert.equal(
		late,
		early,
		`cutting must stop once there is no surplus: ${early} then ${late} frames`
	);
});
