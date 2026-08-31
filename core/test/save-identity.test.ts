/**
 * What one line of a save tile is allowed to say.
 *
 * The tile used to print the timestamp twice - once as the name, once as the
 * date underneath - because `autoSaveName` builds the name out of the date and
 * nothing in the app can rename a save afterwards. In a 20rem panel that left
 * about twenty pixels for both, so the name rendered as "2…" and the date
 * painted itself over the action label. Folding the two into one line is what
 * gives the tile its width back; the CSS only stops the bleeding.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { autoSaveName } from '../../frontend/src/lib/saves/api.js';
import { saveIdentity } from '../../frontend/src/lib/saves/identity.js';

const CREATED = '2026-08-23T16:29:54.000Z';
const UPDATED = '2026-08-23T18:05:00.000Z';

const save = (over: Partial<Record<string, unknown>> = {}) =>
	({
		id: 's1',
		name: autoSaveName('fr', new Date(CREATED)),
		slotNumber: 1,
		screenshot: null,
		createdAt: CREATED,
		updatedAt: CREATED,
		...over
	}) as never;

test('an auto-named save says the moment once, not twice', () => {
	const identity = saveIdentity(save(), 'fr');

	assert.equal(identity.secondary, undefined, 'the date line is what made it overlap');
	assert.match(identity.primary, /23\/08\/2026/);
	assert.match(identity.primary, /18:29|16:29/, 'and the primary line still carries the time');
});

/*
 * Overwriting keeps the creation-time name and moves `updatedAt`. Reading the
 * name would then report the wrong moment, so the line is built from
 * `updatedAt` - the name is only ever used to decide whether it says anything
 * the date does not.
 */
test('an overwritten auto-named save reports when it was overwritten', () => {
	const identity = saveIdentity(save({ updatedAt: UPDATED }), 'fr');

	assert.equal(identity.secondary, undefined);
	assert.match(identity.primary, /20:05|18:05/, 'the overwrite, not the creation');
});

test('a save with a name of its own keeps it, and gets the date underneath', () => {
	const identity = saveIdentity(save({ name: 'Avant le boss' }), 'fr');

	assert.equal(identity.primary, 'Avant le boss');
	assert.ok(identity.secondary, 'a real name does not carry a timestamp, so the date earns its line');
});

/*
 * `autoSaveName` is locale-dependent, so a save created in French and read in
 * English will not match and falls back to the two-line form. Degraded rather
 * than wrong - the tile stays truthful, it just spends a line it did not have
 * to. Pinned here so the fallback is a known behaviour and not a surprise.
 */
test('switching language falls back to two lines rather than lying', () => {
	const identity = saveIdentity(save(), 'en');

	assert.equal(identity.primary, autoSaveName('fr', new Date(CREATED)));
	assert.ok(identity.secondary);
});
