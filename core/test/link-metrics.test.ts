import test from 'node:test';
import assert from 'node:assert/strict';
import { LinkMetrics } from '../../frontend/src/lib/znet/link-metrics.js';

const NTSC = 60.0988;

test('jitter is measured against the machine cadence, not the wall clock', () => {
	// The sender emits one packet per frame it runs, so the frames between two
	// packets are the intended gap. Assuming 60 flat on a PAL session makes
	// every packet look 3.36ms late and reports a steady link as jittery.
	const m = new LinkMetrics(NTSC);
	const frameMs = 1000 / NTSC;

	m.samplePadArrival(100, 0);
	m.samplePadArrival(101, frameMs);
	m.samplePadArrival(102, frameMs * 2);

	assert.ok((m.jitter ?? 1) < 0.01, `a perfectly cadenced link reads calm, got ${m.jitter}`);
});

test('jitter is unknown until pads are actually flowing', () => {
	const m = new LinkMetrics(NTSC);
	assert.equal(m.jitter, null);
	m.samplePadArrival(100, 0);
	assert.equal(m.jitter, null, 'one arrival is not a spacing');
});

test('a reordered packet does not move the figure much', () => {
	// RFC 3550 smoothing, gain 1/16: slow enough to ignore one bad packet,
	// quick enough to follow a route that changes.
	const m = new LinkMetrics(NTSC);
	const frameMs = 1000 / NTSC;
	for (let i = 0; i < 20; i++) m.samplePadArrival(100 + i, frameMs * i);
	const calm = m.jitter ?? 0;

	m.samplePadArrival(119, frameMs * 19); // older frame, must be ignored
	assert.equal(m.jitter, calm, 'a frame at or below the newest is not a sample');
});

test('a round trip is measured only for a ping that was sent', () => {
	const m = new LinkMetrics(NTSC);
	m.notePingSent(1, 1000);

	assert.equal(m.notePingReply(2, 1050), null, 'an unknown id is not a sample');
	assert.equal(m.notePingReply(1, 1050), 50);
	assert.equal(m.rtt, 50);
	assert.equal(m.notePingReply(1, 1100), null, 'and it is consumed');
});

test('late frames are counted over a sliding window', () => {
	// A gap this much wider than the machine's own is a stutter a player sees.
	const m = new LinkMetrics(NTSC);
	const frameMs = 1000 / NTSC;
	let at = 0;
	m.noteFrameRun(at, false);
	for (let i = 0; i < 10; i++) {
		at += frameMs;
		m.noteFrameRun(at, true);
	}
	assert.equal(m.strain, 0, 'a machine on cadence has no strain');

	for (let i = 0; i < 5; i++) {
		at += frameMs * 3;
		m.noteFrameRun(at, true);
	}
	assert.equal(m.strain, 5, 'and five stutters read as five');
});

test('an even pad stream reads as no gap and no clump', () => {
	// The control. One packet per frame run, arriving one frame apart, is what
	// the delay budget assumes and what neither figure should ever flag.
	const m = new LinkMetrics(NTSC);
	const frameMs = 1000 / NTSC;
	let at = 0;
	for (let f = 1; f <= 120; f++) {
		at += frameMs;
		m.samplePadArrival(f, at);
	}
	assert.ok(m.arrivalGap <= frameMs * 1.2, `even delivery must not read as a gap: ${m.arrivalGap}`);
	assert.equal(m.arrivalClump, 1, 'each delivery advanced exactly one frame');
});

test('pads delivered in clumps are reported as gap and clump', () => {
	// What a relay actually does under load, and the thing `jitter` cannot say.
	// Four frames arrive together, then nothing for four frames' worth of time:
	// the average spacing is identical to an even stream, which is exactly why
	// an averaging estimator reads the two as the same link.
	const m = new LinkMetrics(NTSC);
	const frameMs = 1000 / NTSC;
	let at = 0;
	let frame = 0;
	for (let burst = 0; burst < 30; burst++) {
		at += frameMs * 4;
		for (let i = 0; i < 4; i++) m.samplePadArrival(++frame, at + i * 0.2);
	}
	assert.ok(m.arrivalGap > frameMs * 3, `the silence before a clump must show: ${m.arrivalGap}`);
	assert.equal(m.arrivalClump, 1, 'four separate packets each advanced one frame');
});

test('a single delivery carrying several frames is a clump of that size', () => {
	// The other shape the same cause takes: the relay coalesces the packets
	// rather than merely delaying them, so one arrival carries the whole run.
	const m = new LinkMetrics(NTSC);
	const frameMs = 1000 / NTSC;
	let at = 0;
	for (let burst = 1; burst <= 30; burst++) {
		at += frameMs * 5;
		m.samplePadArrival(burst * 5, at);
	}
	assert.equal(m.arrivalClump, 5, 'one arrival advanced five frames at once');
	assert.ok(m.arrivalGap > frameMs * 4, `and the silence before it must show too: ${m.arrivalGap}`);
});

test('one clump in a calm stream is not averaged away', () => {
	// The whole reason this instrument exists. Measured on a real session,
	// `jitter` read 2.0ms calm and 2.1ms while the link was loaded and the RTT
	// p90 rose 42% - its RFC 3550 smoothing, gain 1/16, is built to ignore
	// exactly the excursion that starves a lockstep buffer. These are maxima
	// over a window for that reason: a peak that has to survive being averaged
	// with two hundred quiet neighbours will not.
	const m = new LinkMetrics(NTSC);
	const frameMs = 1000 / NTSC;
	let at = 0;
	let frame = 0;
	for (let i = 0; i < 40; i++) {
		at += frameMs;
		m.samplePadArrival(++frame, at);
	}
	const calm = m.arrivalGap;
	at += frameMs * 6;
	m.samplePadArrival(++frame, at);

	assert.ok(calm <= frameMs * 1.2, `the calm stretch reads calm: ${calm}`);
	assert.ok(m.arrivalGap > frameMs * 5, `and the single excursion survives it: ${m.arrivalGap}`);
});

test('a machine that paces its own frames badly is not a strained link', () => {
	// The production ratchet this closes. A host running its emulator in bursts
	// reported 25 late frames in every window while its stall counter sat still
	// for a hundred and forty seconds - it was never once short of its partner's
	// pads. The partner reads that number as "your delay is starving me" and is
	// the only side that can act on it, so it walked itself to MAX_INPUT_DELAY,
	// one frame per ten seconds, for a stutter no delay of its own could mend.
	//
	// Lateness this side caused itself must therefore not travel. What is left
	// is what the partner can actually fix.
	const m = new LinkMetrics(NTSC);
	const frameMs = 1000 / NTSC;
	let at = 0;
	m.noteFrameRun(at, false);
	for (let i = 0; i < 60; i++) {
		at += frameMs * 3;
		m.noteFrameRun(at, false);
	}
	assert.equal(m.strain, 0, 'sixty stutters of our own making are not the link');
});

test('the peer strain is recorded even when nothing will act on it', () => {
	const m = new LinkMetrics(NTSC);
	m.notePeerStrain(27);
	assert.equal(m.peerStrain, 27);
});
