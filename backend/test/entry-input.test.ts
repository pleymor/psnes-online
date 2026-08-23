/**
 * What a player typed, on its way to the database.
 *
 * Everything is optional by design, which means this function's job is to turn
 * an arbitrary JSON body into a row that cannot be malformed: no undefined
 * (better-sqlite3 throws on binding one), no empty strings pretending to be
 * values, and a title, because the column is NOT NULL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseEntry, MAX_FIELD, MAX_DESCRIPTION } from '../src/api/entry-input.js';

test('an empty body still yields a valid row, titled after the game', () => {
  const entry = sanitiseEntry({}, 'smw.sfc');

  assert.equal(entry.title, 'smw.sfc');
  assert.equal(entry.genre, null);
  assert.equal(entry.altTitle, null);
  assert.equal(entry.description, null);
});

test('what the player typed is kept, trimmed', () => {
  const entry = sanitiseEntry({ title: '  Super Mario World  ', genre: 'Platform' }, 'smw.sfc');

  assert.equal(entry.title, 'Super Mario World');
  assert.equal(entry.genre, 'Platform');
});

test('a field left blank is null, never an empty string', () => {
  // An empty string would show up as a present-but-blank genre in every UI
  // that tests truthiness on it.
  const entry = sanitiseEntry({ genre: '   ', title: '' }, 'smw.sfc');

  assert.equal(entry.genre, null);
  assert.equal(entry.title, 'smw.sfc', 'a blank title falls back like a missing one');
});

test('a value that is not a string is dropped rather than coerced', () => {
  const entry = sanitiseEntry({ genre: 42, players: ['1', '2'], region: null }, 'smw.sfc');

  assert.equal(entry.genre, null);
  assert.equal(entry.players, null);
  assert.equal(entry.region, null);
});

test('a non-object body is treated as an empty one', () => {
  assert.equal(sanitiseEntry(null, 'smw.sfc').title, 'smw.sfc');
  assert.equal(sanitiseEntry('nonsense', 'smw.sfc').title, 'smw.sfc');
});

test('fields are capped rather than refused', () => {
  const entry = sanitiseEntry(
    { title: 'T'.repeat(500), description: 'D'.repeat(5000) },
    'smw.sfc'
  );

  assert.equal(entry.title.length, MAX_FIELD);
  assert.equal(entry.description!.length, MAX_DESCRIPTION);
});

test('unknown keys do not travel', () => {
  const entry = sanitiseEntry({ title: 'Ok', source: 'catalogue', id: 'hijack' }, 'smw.sfc');

  assert.equal(Object.hasOwn(entry, 'source'), false);
  assert.equal(Object.hasOwn(entry, 'id'), false);
});
