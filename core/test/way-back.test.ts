/**
 * Where the top bar offers a labelled way back, and where it deliberately
 * offers none.
 *
 * The bar already carried a way home - the `🎮 PSNES` brand - and a brand that
 * links home is a convention the web honours without announcing it. On
 * /profile it was the *only* way back, so the affordance was there and did not
 * read as one. The fix is a labelled link, and the only thing worth pinning in
 * a test is which screens get it: a "back to the library" on the room screen
 * would be a plain navigation where the page owns an action (`room:release-game`
 * and, for a room of one, `room:leave`), and would walk the player out of the
 * library still seated in a room the server thinks they are in. A wrong way
 * back is worse than none, so the rule is an allowlist rather than a
 * "everywhere but the library".
 *
 * A `frontend/` module imported straight into a node test, the way
 * `game-click.test.ts` already does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { wayBack } from '../../frontend/src/lib/nav/way-back.js';

test('the library itself offers no way back to the library', () => {
	assert.equal(wayBack('/'), null);
});

test('the profile screen gets a labelled link home - the finding that prompted this', () => {
	assert.deepEqual(wayBack('/profile'), { href: '/', label: 'backToLibrary' });
});

test('a trailing slash is the same screen', () => {
	assert.deepEqual(wayBack('/profile/'), { href: '/', label: 'backToLibrary' });
	assert.equal(wayBack(''), null);
});

test('a room offers none: leaving one is an action the page owns, not a navigation', () => {
	// `releaseGame` detaches the game, gives up a seat nobody else holds and
	// forgets the remembered room. A bare href to `/` does none of that.
	assert.equal(wayBack('/room/r1'), null);
	assert.equal(wayBack('/room/r1/'), null);
});

test('an unknown screen offers none rather than a guess', () => {
	// The room is the proof that "anywhere but the library" is the wrong
	// default: a screen nobody has thought about gets nothing until somebody
	// does.
	assert.equal(wayBack('/settings'), null);
	assert.equal(wayBack('/profile/extra'), null);
});
