import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
	DelayController,
	suggestInputDelay,
	autoFloor,
	MIN_INPUT_DELAY,
	MAX_INPUT_DELAY
} from '../../frontend/src/lib/znet/delay-control.js';

const NTSC = 60.0988;
const auto = () => new DelayController({ fps: NTSC, hungerSeconds: 10, automatic: true });

test('the estimator discards the warm-up outlier before measuring spread', () => {
	// A session's first round trip carries the socket, TLS and the relay's route
	// cache all waking up. It reads far above the link and never repeats.
	const withOutlier = suggestInputDelay([40, 42, 41, 43, 300], NTSC);
	const without = suggestInputDelay([40, 42, 41, 43], NTSC);
	assert.equal(withOutlier, without);
});

test('two slow samples are a slow link, not two outliers', () => {
	assert.ok(suggestInputDelay([40, 42, 41, 300, 310], NTSC) > suggestInputDelay([40, 42, 41, 43], NTSC));
});

test('the estimate never leaves its bounds', () => {
	assert.equal(suggestInputDelay([1, 1, 1, 1, 1], NTSC), MIN_INPUT_DELAY);
	assert.equal(suggestInputDelay([5000, 5000, 5000, 5000, 5000], NTSC), MAX_INPUT_DELAY);
	assert.equal(suggestInputDelay([], NTSC), MIN_INPUT_DELAY);
});

test('one rough patch costs nothing', () => {
	// Strain arrives fifty times a second. Counting packets rather than seconds
	// let a single three-second burst buy a permanent frame.
	const c = auto();
	for (let ms = 0; ms < 3000; ms += 20) {
		assert.equal(c.observePeerStrain(27, 5, ms), null, `no verdict at ${ms}ms`);
	}
});

test('ten strained seconds inside the window earn a frame', () => {
	const c = auto();
	let verdict = null;
	for (let s = 0; s < 12 && !verdict; s++) verdict = c.observePeerStrain(27, 5, s * 1000);
	assert.deepEqual(verdict?.delta, 1);
});

test('a clean window gives a frame back, and needs three times the evidence', () => {
	// Quick to protect the other player, slow to reclaim latency for this one.
	const c = auto();
	let down = null;
	for (let s = 0; s < 40 && !down; s++) down = c.observePeerStrain(0, 5, s * 1000);
	assert.equal(down?.delta, -1);
	assert.ok(down !== null);
});

test('the automatic floor is respected on the way down', () => {
	const c = auto();
	let verdict = null;
	for (let s = 0; s < 40 && !verdict; s++) verdict = c.observePeerStrain(0, 2, s * 1000);
	assert.equal(verdict, null, 'two frames is the floor the loop may walk to');
});

test('the ceiling is respected on the way up', () => {
	const c = auto();
	let verdict = null;
	for (let s = 0; s < 20 && !verdict; s++) verdict = c.observePeerStrain(27, MAX_INPUT_DELAY, s * 1000);
	assert.equal(verdict, null);
});

test("a pinned delay is never moved behind the player's back", () => {
	const c = auto();
	c.pin();
	let verdict = null;
	for (let s = 0; s < 40 && !verdict; s++) verdict = c.observePeerStrain(27, 5, s * 1000);
	assert.equal(verdict, null);
});

test('handing control back starts the evidence fresh', () => {
	// What the link did while nobody was acting on it must not spend a frame the
	// instant control returns.
	const c = auto();
	for (let s = 0; s < 9; s++) c.observePeerStrain(27, 5, s * 1000);
	c.pin();
	c.resumeAutomatic();
	assert.equal(c.observePeerStrain(27, 5, 9000), null, 'the nine strained seconds are gone');
});

test('a gap longer than the window clears it instead of replaying it', () => {
	// A stall or a backgrounded tab must not read as thirty strained seconds.
	const c = auto();
	for (let s = 0; s < 9; s++) c.observePeerStrain(27, 5, s * 1000);
	assert.equal(c.observePeerStrain(27, 5, 120_000), null);
});

/* ------------------------------------------- the floor follows the link */

test('a link short enough for one frame lets the loop walk to one', () => {
  // The floor of two was measured on a 52ms relay path. A direct channel at a
  // third of that is a different link, and the same argument that licensed two
  // there licenses one here: the requirement is the trip, not a constant.
  assert.equal(autoFloor(19, NTSC), 1, 'a direct channel');
  assert.equal(autoFloor(50, NTSC), 2, 'a relay');
  assert.equal(autoFloor(120, NTSC), 2, 'a bad relay is not made worse');
});

test('the floor moves with the frame, not with a hard-coded millisecond', () => {
  // PAL runs at 50.007Hz and its frame is 20ms, so a trip that needs two frames
  // on NTSC can fit in one here. Nothing in this may assume 60Hz.
  const PAL = 50.007;
  assert.equal(autoFloor(38, PAL), 1, 'fits one 20ms frame');
  assert.equal(autoFloor(38, NTSC), 2, 'does not fit one 16.6ms frame');
});

test('a direct channel does not need the margin a TCP relay does', () => {
  // The two-frame margin exists to absorb the clumps a TCP relay delivers in.
  // An unordered SCTP channel does not clump, so paying for it there is paying
  // for nothing - and it is what keeps a 19ms link at three frames.
  const onRelay = suggestInputDelay([19, 19, 19, 19, 19], NTSC);
  const onDirect = suggestInputDelay([19, 19, 19, 19, 19], NTSC, { margin: 1, floor: 1 });

  assert.equal(onRelay, 3, 'unchanged: the relay still pays for its clumps');
  assert.ok(onDirect < onRelay, `a direct channel asks for less (${onDirect} < ${onRelay})`);
  assert.equal(onDirect, 2, 'one frame for the trip, one of slack');
});

test('the loop walks down to whatever floor the link justifies', () => {
  // The floor is the caller's to supply now, because only the session knows
  // what the link is measuring. Passing nothing keeps the old two.
  const quiet = (floor?: number) => {
    const c = new DelayController({ fps: NTSC, hungerSeconds: 3, automatic: true });
    let verdict = null;
    for (let s = 0; s < 40 && !verdict; s++) verdict = c.observePeerStrain(0, 2, s * 1000, floor);
    return verdict;
  };

  assert.equal(quiet(), null, 'two is the floor when none is given');
  assert.equal(quiet(1)?.delta, -1, 'and one when the link has earned it');
});

test('a path that has just changed is not judged on the old one', () => {
  // Strain gathered over the relay says nothing about the direct channel that
  // replaced it, and left in the ring it would push the delay straight back up.
  const c = new DelayController({ fps: NTSC, hungerSeconds: 3, automatic: true });
  for (let s = 0; s < 3; s++) c.observePeerStrain(99, 3, s * 1000);

  c.pathChanged();

  let verdict = null;
  for (let s = 3; s < 8 && !verdict; s++) verdict = c.observePeerStrain(0, 3, s * 1000);
  assert.equal(verdict, null, 'the old strain does not raise the delay');
});

test('a link that halves durably asks for a resize, and one that dips does not', () => {
	/*
	 * `onPathShortened` only ever hears about the channel *this* peer holds, so
	 * the peer that did not change network is never told anything - measured on
	 * 2026-09-19, where a handover on the phone left the PC's round trip falling
	 * from 68ms to 12ms with no transport event of any kind, and its delay stuck
	 * at 6-7 frames while the strain loop gave back one frame per quiet thirty
	 * seconds.
	 *
	 * The round trip itself is the signal that needs no event, and it is read
	 * raw: the smoothed figure has a gain of 0.3 over a sample every two
	 * seconds, so it takes some twenty seconds to admit a change - the very trap
	 * that made the path-shortened resize a no-op.
	 */
	const c = auto();
	assert.equal(c.noteLinkSample(70), false, 'the first sample is only the floor');

	assert.equal(c.noteLinkSample(14), false, 'one short sample is a dip');
	assert.equal(c.noteLinkSample(14), false, 'two is still a dip');
	assert.equal(c.noteLinkSample(14), true, 'three consecutive is a shorter link');
});

test('a sample back at the old length breaks the run', () => {
	// Otherwise a link that flickers short every few seconds would eventually
	// collect three and be resized on a length it does not hold.
	const c = auto();
	c.noteLinkSample(70);

	assert.equal(c.noteLinkSample(14), false);
	assert.equal(c.noteLinkSample(14), false);
	assert.equal(c.noteLinkSample(68), false, 'the link is what it was');
	assert.equal(c.noteLinkSample(14), false, 'so the count starts over');
	assert.equal(c.noteLinkSample(14), false);
	assert.equal(c.noteLinkSample(14), true);
});

test('a modest improvement is not a shorter link', () => {
	// Half or better, because that is the size of change a path swap makes.
	// Anything less is the ordinary breathing of a link, and the strain loop
	// already owns that.
	const c = auto();
	c.noteLinkSample(70);
	for (let i = 0; i < 10; i++) {
		assert.equal(c.noteLinkSample(40), false, 'forty against seventy is just a good minute');
	}
});

test('a pinned delay is never resized by the link getting shorter', () => {
	// An escape hatch that moves by itself is not one.
	const c = auto();
	c.noteLinkSample(70);
	c.pin();
	for (let i = 0; i < 5; i++) assert.equal(c.noteLinkSample(14), false);
});

test('a rough patch ending is not a shorter link', () => {
	/*
	 * The regression that the first design walked into, caught by the burst
	 * test in netcode. Comparing against the round trip at the moment the delay
	 * was chosen, a frame bought during a bad stretch recorded the inflated
	 * figure as the reference - so the stretch merely *ending* read as the link
	 * halving, and the frame was handed straight back. Two regulators undoing
	 * each other, which is precisely what this was designed not to do.
	 *
	 * Against the floor a burst cannot move the reference at all: it only ever
	 * falls.
	 */
	const c = auto();
	c.noteLinkSample(44);
	for (let i = 0; i < 5; i++) c.noteLinkSample(280);

	for (let i = 0; i < 5; i++) {
		assert.equal(c.noteLinkSample(44), false, 'the link is back to what it always was');
	}
});

test('a resize the caller did not make does not spend the trigger', () => {
	/*
	 * Measured on 2026-09-22: a handover took one peer's round trip from 111ms
	 * to 11ms - a factor of ten - and its delay sat at 4-5 for the rest of the
	 * session. The detector had fired exactly once, been refused by the caller,
	 * and never armed again, because firing set the floor to the new length as
	 * though the resize had happened.
	 *
	 * A trigger must not be spent on an attempt. The caller says when a resize
	 * actually took effect; until then the link is still the shorter one it was
	 * measured to be, and saying so again costs nothing.
	 */
	const c = auto();
	c.noteLinkSample(70);

	c.noteLinkSample(14);
	c.noteLinkSample(14);
	assert.equal(c.noteLinkSample(14), true, 'the link is shorter');

	// The caller refused - a floor, a pin, anything. Three more samples and it
	// must say so again.
	c.noteLinkSample(14);
	c.noteLinkSample(14);
	assert.equal(c.noteLinkSample(14), true, 'and it is still shorter, so it says so again');
});

test('once a resize is confirmed the shorter link becomes the new normal', () => {
	// The other half: a link that has been acted on is no longer news, or the
	// delay would be walked down again every six seconds for ever.
	const c = auto();
	c.noteLinkSample(70);
	c.noteLinkSample(14);
	c.noteLinkSample(14);
	assert.equal(c.noteLinkSample(14), true);

	c.noteResized(14);

	for (let i = 0; i < 10; i++) {
		assert.equal(c.noteLinkSample(14), false, 'fourteen is what this link is now');
	}
});
