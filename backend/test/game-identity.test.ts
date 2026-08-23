/**
 * How a game's identity is decided.
 *
 * The asymmetry is the whole content of this module: a CRC32 link is exact
 * evidence a human posted, while the descriptive columns on a Game row are
 * whatever an approximate title match happened to produce. So the catalogue
 * wins field by field -- and only where it actually has something to say.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeIdentity, needsIdentification } from '../src/db/game-identity.js';
import type { Game } from '../src/db/types.js';

const GAME: Game = {
  id: 'g1', title: 'smw.sfc', filename: 'smw.sfc', coverUrl: null,
  uploadedAt: new Date(0), genre: null, publisher: null, developer: null,
  releaseDate: null, players: null, region: null, description: null,
  crc32: 'DEADBEEF', sram: null, sramUpdatedAt: null, userId: 'u1'
};

const IDENTITY = {
  title: 'Super Mario World', genre: 'Platform', publisher: 'Nintendo',
  developer: 'Nintendo EAD', releaseDate: '1990-11-21', players: '2',
  region: 'NTSC', description: 'A platformer.', coverUrl: '/api/covers/m1?v=7'
};

test('with no identity, the game is left exactly as it was', () => {
  assert.deepEqual(mergeIdentity(GAME, null), GAME);
});

test('the catalogue wins field by field', () => {
  const merged = mergeIdentity(GAME, IDENTITY);

  assert.equal(merged.title, 'Super Mario World', 'the filename gives way to the real title');
  assert.equal(merged.genre, 'Platform');
  assert.equal(merged.coverUrl, '/api/covers/m1?v=7');
  assert.equal(merged.crc32, 'DEADBEEF', 'nothing outside the descriptive fields moves');
  assert.equal(merged.filename, 'smw.sfc');
});

test('a hole in the entry falls back to the game row rather than blanking it', () => {
  // A player fills in what they know. An entry with no genre must not erase a
  // genre a title match had already found.
  const guessed: Game = { ...GAME, genre: 'Platform', publisher: 'Nintendo' };

  const merged = mergeIdentity(guessed, { ...IDENTITY, genre: null, publisher: null });

  assert.equal(merged.genre, 'Platform');
  assert.equal(merged.publisher, 'Nintendo');
});

test('an entry with no title at all leaves the game titled as it was', () => {
  const merged = mergeIdentity(GAME, { ...IDENTITY, title: null });
  assert.equal(merged.title, 'smw.sfc');
});

test('a game nothing knows anything about needs identifying', () => {
  assert.equal(needsIdentification(GAME, null), true);
});

test('a linked game never needs identifying, however empty the entry', () => {
  const bare = {
    title: null, genre: null, publisher: null, developer: null, releaseDate: null,
    players: null, region: null, description: null, coverUrl: null
  };
  assert.equal(needsIdentification(GAME, bare), false);
});

test('a game a title match already filled in is left alone', () => {
  // This is what keeps the badge off forty cards that are already fine. It is
  // deliberately generous: one known field is enough to stay quiet.
  const guessed: Game = { ...GAME, genre: 'Platform' };
  assert.equal(needsIdentification(guessed, null), false);
});
