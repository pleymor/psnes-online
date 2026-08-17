/**
 * Tests for the connected-user map.
 *
 * The bug these exist for: a reconnect registers the new socket immediately,
 * but the server may not close the old one until its ping timeout, up to
 * twenty seconds later. Handling that late disconnect as if the user had left
 * removed the entry belonging to the *live* connection, and from then on every
 * targeted emit to that user went nowhere - a room they were invited to never
 * appeared until they reloaded the page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Presence } from '../../backend/src/websocket/presence.js';

const alice = { id: 'alice', displayName: 'Alice' } as never;
const bob = { id: 'bob', displayName: 'Bob' } as never;

test('resolves a user to their socket', () => {
	const presence = new Presence();
	presence.register(alice, 'socket-1');

	assert.equal(presence.socketFor('alice'), 'socket-1');
	assert.equal(presence.userFor('socket-1'), alice);
	assert.equal(presence.socketFor('nobody'), undefined);
});

test('a late disconnect from a replaced socket changes nothing', () => {
	const presence = new Presence();

	// The blink: the client reconnects and registers before the server has
	// noticed the old socket is gone.
	presence.register(alice, 'socket-1');
	presence.register(alice, 'socket-2');

	const wasCurrent = presence.unregister('alice', 'socket-1');

	assert.equal(wasCurrent, false, 'the caller must be told this was a stale socket');
	assert.equal(
		presence.socketFor('alice'),
		'socket-2',
		'the live connection must survive the old one closing'
	);
	assert.deepEqual(presence.onlineUserIds, ['alice'], 'and the user is still online');
});

test('closing the current socket does remove the user', () => {
	const presence = new Presence();
	presence.register(alice, 'socket-1');

	assert.equal(presence.unregister('alice', 'socket-1'), true);
	assert.equal(presence.socketFor('alice'), undefined);
	assert.deepEqual(presence.onlineUserIds, []);
});

test('one user disconnecting leaves the others alone', () => {
	const presence = new Presence();
	presence.register(alice, 'socket-1');
	presence.register(bob, 'socket-2');

	presence.unregister('alice', 'socket-1');

	assert.equal(presence.socketFor('bob'), 'socket-2');
	assert.deepEqual(presence.onlineUserIds, ['bob']);
});

test('isCurrent distinguishes the live socket from a superseded one', () => {
	const presence = new Presence();
	presence.register(alice, 'socket-1');
	assert.equal(presence.isCurrent('alice', 'socket-1'), true);

	presence.register(alice, 'socket-2');
	assert.equal(presence.isCurrent('alice', 'socket-1'), false);
	assert.equal(presence.isCurrent('alice', 'socket-2'), true);
});

test('a replaced socket stops resolving to its user', () => {
	// Otherwise a stale socket id would still look like a valid session.
	const presence = new Presence();
	presence.register(alice, 'socket-1');
	presence.register(alice, 'socket-2');
	presence.unregister('alice', 'socket-1');

	assert.equal(presence.userFor('socket-1'), undefined);
	assert.equal(presence.userFor('socket-2'), alice);
});
