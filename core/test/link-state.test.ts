/**
 * Tests for the socket link-state machine.
 *
 * The bug these exist for: a player whose browser or network cannot open the
 * WebSocket at all never saw anything wrong. `linkState` started 'connected'
 * so the first connect would not flash a banner, and nothing listened to
 * socket.io's `connect_error` - so a socket that never once connected left the
 * store on 'connected' forever. The app looked healthy while presence and
 * invitations, which exist only on the socket, silently did nothing. It read
 * as a broken friendship rather than a blocked connection.
 *
 * A failed *first* connect and a failed *reconnect* are not the same state:
 * "connection lost" is a lie to someone who never had one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';

import { attachLinkState, linkState } from '../../frontend/src/lib/stores/connection.js';

/** The subset of a socket.io client the machine listens to. */
function fakeSocket() {
	const handlers = new Map<string, (...args: unknown[]) => void>();
	return {
		on(event: string, handler: (...args: unknown[]) => void) {
			handlers.set(event, handler);
			return this;
		},
		emit(event: string, ...args: unknown[]) {
			const handler = handlers.get(event);
			assert.ok(handler, `nothing listens to '${event}'`);
			handler!(...args);
		}
	};
}

function attached() {
	linkState.set('connected');
	const socket = fakeSocket();
	attachLinkState(socket);
	return socket;
}

test('a socket that never connects reports itself unreachable', () => {
	const socket = attached();

	socket.emit('connect_error', new Error('websocket error'));

	assert.equal(get(linkState), 'unreachable');
});

test('retries after a failed first connect stay unreachable', () => {
	const socket = attached();

	socket.emit('connect_error', new Error('websocket error'));
	socket.emit('connect_error', new Error('websocket error'));

	assert.equal(get(linkState), 'unreachable');
});

test('connecting clears an earlier unreachable', () => {
	const socket = attached();

	socket.emit('connect_error', new Error('websocket error'));
	socket.emit('connect');

	assert.equal(get(linkState), 'connected');
});

test('a drop after a successful connect is a reconnect, not unreachable', () => {
	const socket = attached();

	socket.emit('connect');
	socket.emit('disconnect', 'transport close');
	// socket.io raises connect_error on every failed retry. Downgrading to
	// 'unreachable' here would tell a player who was playing a minute ago that
	// the server was never reachable.
	socket.emit('connect_error', new Error('websocket error'));

	assert.equal(get(linkState), 'reconnecting');
});

test('an explicit disconnect from either end is offline, and stays offline', () => {
	for (const reason of ['io client disconnect', 'io server disconnect']) {
		const socket = attached();

		socket.emit('connect');
		socket.emit('disconnect', reason);

		assert.equal(get(linkState), 'offline', reason);
	}
});

test('the server refusing a socket before it ever connected is offline, not unreachable', () => {
	// The onboarding gate: the server emits auth:pseudoRequired and hangs up on
	// the handshake. socket.io does not retry an 'io server disconnect', so
	// "reconnecting…" would be a lie - and so would "unreachable", because the
	// server answered.
	const socket = attached();

	socket.emit('disconnect', 'io server disconnect');

	assert.equal(get(linkState), 'offline');
});
