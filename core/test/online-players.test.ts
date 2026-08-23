/**
 * The client's own copy of "who is actually here".
 *
 * A deliberate twin of the three tests at the top of
 * `backend/test/presence.test.ts`. The two accessors share no code - the
 * browser and the server have no module in common - so nothing but this file
 * stops them drifting apart. The case that matters most is the third: absent
 * has to mean away on both sides, or one of them will let a game start against
 * somebody who is not there.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { onlinePlayers } from '../../frontend/src/lib/rooms/online-players.js';

const player = (userId: string, online?: boolean) =>
	({ userId, displayName: userId, port: null, isReady: true, online }) as never;

test('the client counts only the players who are here', () => {
	const room = { players: [player('alice', true), player('bob', false)] };
	assert.deepEqual(
		onlinePlayers(room as never).map((p) => p.userId),
		['alice']
	);
});

test('the client counts nobody in a room nobody is in', () => {
	const room = { players: [player('alice', false), player('bob', false)] };
	assert.deepEqual(onlinePlayers(room as never), []);
});

test('the client treats a player with no flag at all as away, not as present', () => {
	const room = { players: [player('alice')] };
	assert.deepEqual(onlinePlayers(room as never), []);
});
