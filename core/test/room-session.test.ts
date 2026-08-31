/**
 * `room-session.ts`: `deriveRoomView`, the lobby's one pure view of a room,
 * and `subscribeToRoom`, the socket wiring behind it.
 *
 * `deriveRoomView` encodes three non-obvious product rules - see each test
 * below for the incident-shaped reasoning behind it. `subscribeToRoom` is
 * covered for the thing its own doc comment says used to go wrong silently: a
 * listener left behind after a navigation, which only shows up several
 * navigations later.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { deriveRoomView, subscribeToRoom } from '../../frontend/src/lib/rooms/room-session.js';
import { EmulationMode, type KeyConfig, type Room, type RoomPlayer } from '../../frontend/src/lib/types.js';

const KEY_CONFIG: KeyConfig = {
	up: 'ArrowUp',
	down: 'ArrowDown',
	left: 'ArrowLeft',
	right: 'ArrowRight',
	a: 'KeyX',
	b: 'KeyZ',
	x: 'KeyS',
	y: 'KeyA',
	l: 'KeyQ',
	r: 'KeyW',
	start: 'Enter',
	select: 'ShiftRight'
};

function player(overrides: Partial<RoomPlayer>): RoomPlayer {
	return {
		userId: 'u1',
		pseudo: 'p1',
		port: 1,
		isReady: true,
		online: true,
		keyConfig: KEY_CONFIG,
		...overrides
	};
}

function room(overrides: Partial<Room>): Room {
	return {
		id: 'room-1',
		hostId: 'u1',
		createdBy: 'u1',
		players: [],
		status: 'waiting',
		emulationMode: EmulationMode.LOCKSTEP,
		...overrides
	} as Room;
}

// ------------------------------------------------------------- deriveRoomView

test('a null room is single-player, with no room-derived flags true', () => {
	const view = deriveRoomView(null, 'u1');

	assert.equal(view.isSinglePlayer, true);
	assert.equal(view.isCreator, false);
	assert.equal(view.isHost, false);
	assert.equal(view.effectiveMode, EmulationMode.SINGLE);
});

test('isSinglePlayer counts ONLINE players, not members - an offline partner still leaves the room single', () => {
	const r = room({
		players: [
			player({ userId: 'u1', online: true }),
			// Closed their tab: still a member of `room.players`, but this must
			// not count as "two players", or a lone player would end up in
			// netplay - two cores exchanging inputs with nobody on the other end.
			player({ userId: 'u2', online: false })
		]
	});

	const view = deriveRoomView(r, 'u1');

	assert.equal(view.isSinglePlayer, true);
});

test('two online players is not single-player', () => {
	const r = room({
		players: [player({ userId: 'u1', online: true }), player({ userId: 'u2', online: true })]
	});

	const view = deriveRoomView(r, 'u1');

	assert.equal(view.isSinglePlayer, false);
});

test('a member with online left undefined (an old snapshot) does not count as online either', () => {
	const r = room({
		players: [player({ userId: 'u1', online: true }), player({ userId: 'u2', online: undefined })]
	});

	const view = deriveRoomView(r, 'u1');

	assert.equal(view.isSinglePlayer, true);
});

test('effectiveMode falls back to SINGLE while alone, even in a lockstep room', () => {
	const r = room({
		emulationMode: EmulationMode.LOCKSTEP,
		players: [player({ userId: 'u1', online: true })]
	});

	const view = deriveRoomView(r, 'u1');

	assert.equal(view.effectiveMode, EmulationMode.SINGLE);
});

test('effectiveMode is the room mode once a second player is actually online', () => {
	const r = room({
		emulationMode: EmulationMode.LOCKSTEP,
		players: [player({ userId: 'u1', online: true }), player({ userId: 'u2', online: true })]
	});

	const view = deriveRoomView(r, 'u1');

	assert.equal(view.effectiveMode, EmulationMode.LOCKSTEP);
});

test('canResume follows the EFFECTIVE mode, not room.emulationMode - it comes and goes with the partner', () => {
	const withPartner = room({
		emulationMode: EmulationMode.DUAL,
		players: [player({ userId: 'u1', online: true }), player({ userId: 'u2', online: true })]
	});
	// DUAL has no savestate path (P2PRoom) - resuming must be refused.
	assert.equal(deriveRoomView(withPartner, 'u1').canResume, false);

	const partnerLeft = room({
		emulationMode: EmulationMode.DUAL,
		players: [player({ userId: 'u1', online: true }), player({ userId: 'u2', online: false })]
	});
	// Same stored mode, but alone now - effectiveMode collapses to SINGLE,
	// which is SoloRoom, which does resume.
	assert.equal(deriveRoomView(partnerLeft, 'u1').canResume, true);
});

test('canResume is true for LOCKSTEP and false for STREAMING/DUAL, both with a partner present', () => {
	const two = (mode: EmulationMode) =>
		room({
			emulationMode: mode,
			players: [player({ userId: 'u1', online: true }), player({ userId: 'u2', online: true })]
		});

	assert.equal(deriveRoomView(two(EmulationMode.LOCKSTEP), 'u1').canResume, true);
	assert.equal(deriveRoomView(two(EmulationMode.STREAMING), 'u1').canResume, false);
	assert.equal(deriveRoomView(two(EmulationMode.DUAL), 'u1').canResume, false);
});

test('isCreator and isHost are read straight off the room, independently of each other', () => {
	const r = room({ hostId: 'u2', createdBy: 'u1', players: [player({ userId: 'u1' })] });

	const asCreator = deriveRoomView(r, 'u1');
	assert.equal(asCreator.isCreator, true);
	assert.equal(asCreator.isHost, false);

	const asHost = deriveRoomView(r, 'u2');
	assert.equal(asHost.isCreator, false);
	assert.equal(asHost.isHost, true);
});

// -------------------------------------------------------------- subscribeToRoom

/** Enough of a socket.io-client `Socket` for `subscribeToRoom`: `on`/`off`. */
class FakeSocket {
	private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	on(event: string, fn: (...args: unknown[]) => void): void {
		if (!this.listeners.has(event)) this.listeners.set(event, new Set());
		this.listeners.get(event)!.add(fn);
	}

	off(event: string, fn: (...args: unknown[]) => void): void {
		this.listeners.get(event)?.delete(fn);
	}

	listenerCount(event: string): number {
		return this.listeners.get(event)?.size ?? 0;
	}

	totalListeners(): number {
		let total = 0;
		for (const set of this.listeners.values()) total += set.size;
		return total;
	}
}

const SIX_EVENTS = ['connect', 'room:updated', 'game:started', 'game:stopped', 'room:gameReleased', 'error'];

function noop(): void {}

test('subscribeToRoom registers all six listeners, one per event', () => {
	const socket = new FakeSocket();

	subscribeToRoom({
		socket: socket as unknown as import('socket.io-client').Socket,
		onRoom: noop,
		onError: noop,
		onStarted: noop,
		onReconnect: noop,
		onStopped: noop,
		onGameReleased: noop
	});

	for (const event of SIX_EVENTS) {
		assert.equal(socket.listenerCount(event), 1, `expected exactly one listener on "${event}"`);
	}
	assert.equal(socket.totalListeners(), 6);
});

test('the returned teardown removes every listener it registered - none left behind for a dead component', () => {
	const socket = new FakeSocket();

	const unsubscribe = subscribeToRoom({
		socket: socket as unknown as import('socket.io-client').Socket,
		onRoom: noop,
		onError: noop,
		onStarted: noop,
		onReconnect: noop,
		onStopped: noop,
		onGameReleased: noop
	});
	assert.equal(socket.totalListeners(), 6);

	unsubscribe();

	assert.equal(socket.totalListeners(), 0, 'a listener left behind fires against a dead component');
});

test('teardown names its own handler on "connect" rather than a bare off - the socket is shared with other listeners on the same event', () => {
	const socket = new FakeSocket();
	const unrelatedConnectHandler = () => {};
	socket.on('connect', unrelatedConnectHandler);

	const unsubscribe = subscribeToRoom({
		socket: socket as unknown as import('socket.io-client').Socket,
		onRoom: noop,
		onError: noop,
		onStarted: noop,
		onReconnect: noop,
		onStopped: noop,
		onGameReleased: noop
	});
	assert.equal(socket.listenerCount('connect'), 2);

	unsubscribe();

	assert.equal(
		socket.listenerCount('connect'),
		1,
		'tearing down this subscription must not also remove the reconnection banner\'s own connect listener'
	);
});
