/**
 * What a click on a game card does.
 *
 * The same button means three things depending on the state of the group, and
 * that is the one place in this application where a single button does that - so
 * the rule lives in a function with a name rather than in a chain of conditions
 * inside a template, where the third branch would be the one nobody reads.
 *
 * A `frontend/` module imported straight into a node test, the way
 * `online-players.test.ts` already does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { gameClick } from '../../frontend/src/lib/rooms/game-click.js';

const room = (status: 'waiting' | 'playing', members: number) => ({
	id: 'r1',
	status,
	players: Array.from({ length: members }, (_, i) => ({ userId: `u${i}` }))
});

test('with no room at all, a game is launched on its own', () => {
	assert.deepEqual(gameClick(null), { kind: 'launch-solo' });
	assert.deepEqual(gameClick(undefined), { kind: 'launch-solo' });
});

test('a room holding nobody but me is not a group: the game is launched on its own', () => {
	// The leftover of a group the other player left, or of a previous solo game.
	// `room:create` gives up the old seat by itself, so there is nothing special
	// to do here.
	assert.deepEqual(gameClick(room('waiting', 1)), { kind: 'launch-solo' });
});

test('in a group, the game is chosen for the room and the server moves both players', () => {
	assert.deepEqual(gameClick(room('waiting', 2)), { kind: 'choose-for-group', roomId: 'r1' });
});

test('a game already running blocks the click, whatever the group looks like', () => {
	// The server refuses a game change on a playing room, so a click here could
	// only ever earn a refusal. Both shapes are blocked: solo and duo.
	assert.deepEqual(gameClick(room('playing', 2)), { kind: 'blocked', reason: 'playing' });
	assert.deepEqual(gameClick(room('playing', 1)), { kind: 'blocked', reason: 'playing' });
});
