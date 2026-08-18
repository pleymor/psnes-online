/**
 * Room snapshot tests.
 *
 * Rooms live in a plain Map in the backend process, so a restart erases every
 * game in progress. These cover the part of the fix that can be got wrong
 * quietly: a snapshot that reads back as a subtly different room is worse than
 * one that fails to read back at all, because the lobby then looks fine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	deserialiseRooms,
	flushRooms,
	serialiseRooms,
	resetSnapshotStateForTest,
	writeSnapshot
} from '../../backend/src/websocket/room-snapshot.js';

function makeRoom(id: string, playerIds: string[]) {
	return {
		id,
		gameId: 'game-1',
		gameTitle: 'Test',
		gameCrc32: 'abcdef01',
		hostId: playerIds[0] ?? 'nobody',
		createdBy: playerIds[0] ?? 'nobody',
		status: 'playing',
		emulationMode: 'lockstep',
		createdAt: new Date('2026-08-18T06:00:00.000Z'),
		players: playerIds.map((userId) => ({
			userId,
			displayName: userId,
			port: 1,
			isReady: true,
			emulationReady: true,
			keyConfig: {}
		}))
	} as never;
}

function populated() {
	return new Map<string, never>([
		['room-a', makeRoom('room-a', ['host', 'guest'])],
		['room-b', makeRoom('room-b', ['solo'])]
	]);
}

test('a populated map survives a round trip', () => {
	const before = populated();
	const after = deserialiseRooms(serialiseRooms(before as never));

	assert.deepEqual([...after.keys()].sort(), ['room-a', 'room-b']);
	assert.equal(after.get('room-a')!.players.length, 2);
	assert.equal(after.get('room-a')!.status, 'playing');
	assert.equal(after.get('room-a')!.gameCrc32, 'abcdef01');
});

test('createdAt comes back as a Date, not the string JSON made of it', () => {
	// The rest of the app calls Date methods on this field, so a string here
	// is a crash somewhere far from the snapshot.
	const after = deserialiseRooms(serialiseRooms(populated() as never));
	const createdAt = after.get('room-a')!.createdAt;

	assert.ok(createdAt instanceof Date, 'createdAt must be a Date');
	assert.equal(createdAt.toISOString(), '2026-08-18T06:00:00.000Z');
});

test('a room with no players is dropped', () => {
	const rooms = populated();
	rooms.set('empty', makeRoom('empty', []));

	const after = deserialiseRooms(serialiseRooms(rooms as never));
	assert.equal(after.has('empty'), false, 'an empty room has nothing to resume');
	assert.equal(after.size, 2);
});

test('a snapshot from another build is discarded rather than coerced', () => {
	// An old Room shape read into the current type is how a restart produces a
	// lobby that is subtly wrong instead of empty.
	const foreign = JSON.stringify({ version: 99, rooms: [makeRoom('room-a', ['host'])] });
	assert.equal(deserialiseRooms(foreign).size, 0);
});

test('unreadable input yields an empty map instead of throwing', () => {
	assert.equal(deserialiseRooms(null).size, 0);
	assert.equal(deserialiseRooms('').size, 0);
	assert.equal(deserialiseRooms('{not json').size, 0);
});

test('an unchanged map is not written twice', async () => {
	// The snapshot runs every second for the life of the process. Writing an
	// identical blob 86400 times a day is pure waste.
	const writes: Array<{ key: string; value: string }> = [];
	const fake = {
		async set(key: string, value: string) {
			writes.push({ key, value });
			return 'OK';
		},
		async get() {
			return null;
		}
	};

	resetSnapshotStateForTest();
	const rooms = populated();

	assert.equal(await writeSnapshot(rooms as never, fake as never), true);
	assert.equal(await writeSnapshot(rooms as never, fake as never), false);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].key, 'psnes:rooms:v1');

	rooms.delete('room-b');
	assert.equal(await writeSnapshot(rooms as never, fake as never), true);
	assert.equal(writes.length, 2);
});

test('flushing twice writes once', async () => {
	// SIGTERM and SIGINT can both arrive, and the shutdown path must be safe to
	// enter twice: a second flush should re-write nothing and re-arm nothing.
	const writes: string[] = [];
	const fake = {
		async set(_key: string, value: string) {
			writes.push(value);
			return 'OK';
		},
		async get() {
			return null;
		}
	};

	resetSnapshotStateForTest();
	const rooms = populated();

	await flushRooms(rooms as never, fake as never);
	await flushRooms(rooms as never, fake as never);

	assert.equal(writes.length, 1, 'the second flush must be a no-op');
});

test('a write failure is swallowed, not thrown at the caller', async () => {
	// This runs on a timer and on the way out. A rejected promise there is an
	// unhandledRejection, and the shutdown path is the last place we want one.
	const failing = {
		async set() {
			throw new Error('redis is gone');
		},
		async get() {
			return null;
		}
	};

	resetSnapshotStateForTest();
	assert.equal(await writeSnapshot(populated() as never, failing as never), false);
});
