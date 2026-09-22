/**
 * What the machine itself is doing, as opposed to the link.
 *
 * The arithmetic and the contract live here so they can be tested without a
 * browser; the component keeps the PerformanceObserver and the globals.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
	FrameTimes,
	HostHealth,
	readApiRtt,
	readDownlink,
	readHeapMb,
	readLinkClass
} from '../../frontend/src/lib/znet/host-health.js';

test('blocked time is reported per interval, not cumulated for the session', () => {
	// The telemetry line is one sample per second and each has to describe its
	// own second. A running total would read as a machine getting steadily
	// worse for the length of the session, which is the opposite of what a
	// reader needs: a burst has to be visible as a burst.
	const h = new HostHealth();
	h.noteLongTask(120);
	h.noteLongTask(80);

	assert.equal(h.takeLongTasks(), 200, 'the first second saw two hundred ms of blocking');
	assert.equal(h.takeLongTasks(), 0, 'and a quiet second that follows reads quiet');
});

test('a missing browser API reads null, which is not the same as zero', () => {
	// `heapMb` is Chrome-only and the connection API is mostly Android.
	// Shipping the field as null where the API is absent keeps "we could not
	// look" apart from "we looked and it was nothing" - two readings a
	// diagnosis must never confuse.
	assert.equal(readLinkClass({}), null, 'no connection API at all');
	assert.equal(readLinkClass({ connection: {} }), null, 'the API is there but says nothing');

	assert.equal(readHeapMb({}), null, 'no memory API at all');
	assert.equal(readHeapMb({ memory: { usedJSHeapSize: 48 * 1024 * 1024 } }), 48);
});

test('the connection API reports a quality class, never a radio', () => {
	/*
	 * `effectiveType` is one of slow-2g / 2g / 3g / 4g and means "this link
	 * behaves like...". It never returns "wifi": a good WiFi connection reports
	 * `4g` permanently, which is exactly what it did on 2026-09-19 while both
	 * machines were on WiFi, and the field's name made that reading look like a
	 * measurement rather than a mistake. The physical bearer would be
	 * `connection.type`, which Chrome does not expose to the page at all.
	 *
	 * So the name says what it is, and the two numbers that do move between a
	 * WiFi and a cellular link travel beside it. Together they can date a
	 * change of network; none of them may claim to name it.
	 */
	const wifi = { connection: { effectiveType: '4g', downlink: 9.35, rtt: 50 } };
	assert.equal(readLinkClass(wifi), '4g');
	assert.equal(readDownlink(wifi), 9.35);
	assert.equal(readApiRtt(wifi), 50);

	assert.equal(readDownlink({ connection: {} }), null, 'absent stays null');
	assert.equal(readApiRtt({ connection: {} }), null, 'absent stays null');
});

test('frame times are read as a shape, and the quantum ignores catch-up slices', () => {
	/*
	 * Both readings come from the same intervals, which is why they live
	 * together rather than being measured twice.
	 *
	 * The quantum only considers intervals long enough to be a real
	 * presentation: a catch-up slice puts several frames microseconds apart and
	 * those say nothing about how often a frame reaches the screen. The spread
	 * wants all of them - a frame that took no time is as much part of the shape
	 * as one that took sixty milliseconds.
	 */
	const f = new FrameTimes(8);

	// Six ordinary frames, one catch-up pair, one heavy frame.
	for (const gap of [20, 20, 20, 0.2, 20, 20, 60, 20]) f.note(gap);

	assert.equal(f.quantum, 20, 'the catch-up interval is not a presentation period');
	assert.ok(Math.abs(f.ms50 - 20) < 1, `the median is the ordinary frame, got ${f.ms50}`);
	assert.equal(f.msMax, 60, 'and the worst is kept');
});
