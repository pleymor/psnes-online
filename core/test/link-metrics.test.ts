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
