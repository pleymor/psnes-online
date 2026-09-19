/**
 * What the machine itself is doing, as opposed to the link.
 *
 * The arithmetic and the contract live here so they can be tested without a
 * browser; the component keeps the PerformanceObserver and the globals.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { HostHealth, readHeapMb, readNetType } from '../../frontend/src/lib/znet/host-health.js';

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
	// `heapMb` is Chrome-only and `netType` is Android-mostly. Shipping the
	// field as null where the API is absent keeps "we could not look" apart
	// from "we looked and it was nothing" - two readings a diagnosis must never
	// confuse.
	assert.equal(readNetType({}), null, 'no connection API at all');
	assert.equal(readNetType({ connection: {} }), null, 'the API is there but says nothing');
	assert.equal(readNetType({ connection: { effectiveType: '4g' } }), '4g');

	assert.equal(readHeapMb({}), null, 'no memory API at all');
	assert.equal(readHeapMb({ memory: { usedJSHeapSize: 48 * 1024 * 1024 } }), 48);
});
