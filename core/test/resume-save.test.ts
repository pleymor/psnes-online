/**
 * Which save this client will ask the server for, when a room opens on one.
 *
 * The rule exists because asking is not free: `game:load` refuses a save its
 * caller does not own, and the room's staged save belongs to the creator - only
 * they may stage one, and only one of their own. A guest that asked anyway got
 * "Not authorized to load this save" thrown at it while the resume worked
 * perfectly around it, because the server broadcasts the answer to the whole
 * room and lockstep's guest waits to be handed the machine rather than applying
 * the bytes itself.
 *
 * So the guest must not ask. That is one condition, and this is where it lives.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resumeSaveToRequest } from '../../frontend/src/lib/rooms/resume-save.js';

test('the creator asks for the save the room is staged on', () => {
	assert.equal(resumeSaveToRequest({ resumeSaveId: 's1' }, true, null), 's1');
});

test('a guest never asks for the room\'s staged save', () => {
	// It is not theirs, the server would refuse it, and the host's request is
	// already broadcast to the whole room.
	assert.equal(resumeSaveToRequest({ resumeSaveId: 's1' }, false, null), null);
});

test('the room wins over the URL for the creator: it is the later word', () => {
	// Arriving on a `?save=` link and then staging something else from the lobby
	// must start on what the lobby chose.
	assert.equal(resumeSaveToRequest({ resumeSaveId: 's1' }, true, 's2'), 's1');
});

test('a save named in my own URL is mine, whatever seat I hold', () => {
	// `?save=` is only ever put there by this client, for a game in its own
	// library, so ownership is not in question.
	assert.equal(resumeSaveToRequest({ resumeSaveId: undefined }, false, 's2'), 's2');
	assert.equal(resumeSaveToRequest(null, false, 's2'), 's2');
});

test('nothing staged and nothing in the URL asks for nothing', () => {
	assert.equal(resumeSaveToRequest(null, true, null), null);
	assert.equal(resumeSaveToRequest({ resumeSaveId: undefined }, true, null), null);
});
