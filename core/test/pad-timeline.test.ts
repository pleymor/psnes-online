import test from 'node:test';
import assert from 'node:assert/strict';
import { PadTimeline } from '../../frontend/src/lib/znet/pad-timeline.js';

test('a run stops at a hole rather than shipping across it', () => {
	// A gap means history was pruned. Shipping across it would mislabel every
	// pad after the hole by the width of the hole, which is a silent desync.
	const t = new PadTimeline();
	t.reset(0, 0);
	t.set(0, 10, 0x01);
	// 11 deliberately absent
	t.set(0, 12, 0x02);
	t.set(0, 13, 0x04);

	const run = t.runEndingAt(0, 10, 13);

	assert.deepEqual(run, { baseFrame: 12, pads: [0x02, 0x04] });
});

test('filling a raise gap leaves no frame behind', () => {
	// tick() only ever fills frame + delay, one entry per executed frame. Push
	// the horizon out and the frames in between are skipped for good unless
	// something fills them: the peer then waits on a pad nobody will send.
	const t = new PadTimeline();
	t.reset(0, 0);
	t.set(0, 100, 0x08);

	t.fillGap(0, 100, 104, t.newestAtOrBelow(0, 100, 0));

	for (let f = 100; f <= 104; f++) {
		assert.equal(t.get(0, f), 0x08, `frame ${f} is filled`);
	}
});

test('filling never overwrites a pad already held', () => {
	const t = new PadTimeline();
	t.reset(0, 0);
	t.set(0, 100, 0x08);
	t.set(0, 102, 0x10);

	t.fillGap(0, 100, 104, 0x08);

	assert.equal(t.get(0, 102), 0x10, 'the real pad wins over the repeat');
});

test('the startup window is primed for both players', () => {
	// Nobody can have sent a pad for the first D frames: their input would have
	// been sampled before the session existed. Both peers fill them with zero,
	// the one value they are guaranteed to agree on.
	const t = new PadTimeline();
	t.reset(500, 3);

	for (let f = 500; f < 503; f++) assert.ok(t.hasAll(f), `frame ${f} primed`);
	assert.equal(t.hasAll(503), false, 'and no further');
});

test('padsAhead counts the contiguous reserve, not the total held', () => {
	const t = new PadTimeline();
	t.reset(0, 0);
	t.set(0, 10, 0); t.set(0, 11, 0); t.set(0, 13, 0);
	t.set(1, 10, 0);

	assert.deepEqual(t.padsAhead(10), [2, 1]);
});

test('pruning clears pads and both checksum sides together', () => {
	const t = new PadTimeline();
	t.reset(0, 0);
	t.set(0, 5, 0x01);
	t.setLocalCrc(5, 0xaaaa);
	t.setRemoteCrc(5, 0xbbbb);
	t.set(0, 50, 0x02);

	t.prune(20);

	assert.equal(t.get(0, 5), undefined);
	assert.equal(t.getLocalCrc(5), undefined);
	assert.equal(t.getRemoteCrc(5), undefined);
	assert.equal(t.get(0, 50), 0x02, 'what is past the cutoff stays');
});
