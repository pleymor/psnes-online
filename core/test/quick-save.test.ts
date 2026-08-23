/**
 * The pieces the F2/F4 shortcuts are built from.
 *
 * All four are pure, which is the point: the shortcuts themselves live inside
 * two room components that no test here can render, so everything that can be
 * got wrong is pulled out to where it can be pinned down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { toBase64 } from '../../frontend/src/lib/saves/base64.js';
import {
	QUICK_SAVE_NAME,
	findQuickSave,
	padUsesKey
} from '../../frontend/src/lib/saves/quick.js';
import type { SaveSummary } from '../../frontend/src/lib/saves/api.js';

const save = (id: string, name: string): SaveSummary => ({
	id,
	name,
	slotNumber: 1,
	screenshot: null,
	createdAt: '2026-08-23T16:00:00.000Z',
	updatedAt: '2026-08-23T16:00:00.000Z'
});

/*
 * The bug the source comment describes, finally pinned.
 *
 * `String.fromCharCode(...bytes)` spreads one argument per byte and blows the
 * call stack somewhere around 100k. A real savestate is over 800KB, so this
 * path was one refactor away from failing on every save ever taken - and
 * nothing tested it.
 */
test('a savestate-sized buffer encodes without blowing the stack', () => {
	const bytes = new Uint8Array(900_000);
	for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

	const encoded = toBase64(bytes);

	assert.equal(encoded, Buffer.from(bytes).toString('base64'));
});

test('an empty buffer encodes to an empty string rather than throwing', () => {
	assert.equal(toBase64(new Uint8Array(0)), '');
});

/*
 * The quick save is found by a fixed sentinel, never by a translated label: a
 * player who switches language would otherwise orphan the one they had and
 * start a second, and the whole point of a single quick slot is that there is
 * one.
 */
test('the quick save is found by its sentinel, whatever else is in the list', () => {
	const list = [save('a', '23/08 16:29'), save('q', QUICK_SAVE_NAME), save('b', 'Avant le boss')];

	assert.equal(findQuickSave(list)?.id, 'q');
});

test('no quick save yet is undefined, not a wrong pick', () => {
	assert.equal(findQuickSave([save('a', '23/08 16:29')]), undefined);
});

test('the sentinel is not something a generated name could collide with', () => {
	// autoSaveName produces locale date strings; this must never be one.
	assert.match(QUICK_SAVE_NAME, /^__/);
});

/*
 * A player may bind F2 to a pad button in the controls screen. Their explicit
 * choice beats our default, so the shortcut stands down rather than firing a
 * save on every shot.
 */
test('a key the player bound to their pad is left to the pad', () => {
	const keyConfig = { a: 'KeyX', b: 'KeyZ', start: 'F2' } as never;

	assert.equal(padUsesKey(keyConfig, 'F2'), true);
	assert.equal(padUsesKey(keyConfig, 'F4'), false);
});

test('no config at all means nothing is bound, rather than throwing', () => {
	assert.equal(padUsesKey(undefined, 'F2'), false);
	assert.equal(padUsesKey({} as never, 'F2'), false);
});
