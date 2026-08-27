import test from 'node:test';
import assert from 'node:assert/strict';
import {
	DelayController,
	suggestInputDelay,
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
