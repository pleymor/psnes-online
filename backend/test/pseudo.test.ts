/**
 * The format rules, and the one place a handle string is taken apart.
 *
 * These are the tests that decide whether the unique index in
 * 0004_pseudonymous_users.sql means anything: the index folds case with
 * COLLATE NOCASE, which SQLite applies to A-Z only, so a validator that let a
 * single accented letter through would put two rows in the database that the
 * index believes are different handles and every human reading them believes
 * are the same one.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { isValidPseudo, parseHandle, formatHandle } from '../src/utils/pseudo.js';

test('a pseudonym is 3 to 16 characters of ASCII letters, digits, _ and -', () => {
  assert.equal(isValidPseudo('Sprite'), true);
  assert.equal(isValidPseudo('a-b_C9'), true);
  assert.equal(isValidPseudo('abc'), true, 'three characters is the floor');
  assert.equal(isValidPseudo('a'.repeat(16)), true, 'sixteen is the ceiling');
});

test('the boundaries are exclusive on both sides', () => {
  assert.equal(isValidPseudo('ab'), false, 'two characters is one too few');
  assert.equal(isValidPseudo('a'.repeat(17)), false, 'seventeen is one too many');
  assert.equal(isValidPseudo(''), false);
});

test('non-ASCII letters are refused, because COLLATE NOCASE cannot fold them', () => {
  assert.equal(isValidPseudo('Emile'), true);
  assert.equal(isValidPseudo('Émile'), false);
  assert.equal(isValidPseudo('Мario'), false, 'a Cyrillic М would impersonate a Latin M');
});

test('spaces and the separator itself are refused', () => {
  assert.equal(isValidPseudo('two words'), false);
  assert.equal(isValidPseudo(' Sprite'), false, 'a leading space would be invisible');
  assert.equal(isValidPseudo('Sprite '), false);
  assert.equal(isValidPseudo('Spri#te'), false, '# separates the handle, it cannot be inside');
});

test('parseHandle splits a well-formed handle', () => {
  assert.deepEqual(parseHandle('Sprite#0417'), { pseudo: 'Sprite', discriminator: '0417' });
  assert.deepEqual(parseHandle('a-b_C9#0000'), { pseudo: 'a-b_C9', discriminator: '0000' });
});

test('parseHandle refuses a second separator', () => {
  // It splits on the LAST '#', so the left-hand side here is 'a#b', which the
  // pseudonym rule rejects. That is the whole reason the split is on the last
  // one rather than the first: it makes a stray '#' fail validation instead of
  // being silently swallowed.
  assert.equal(parseHandle('a#b#0001'), null);
});

test('parseHandle refuses a discriminator that is not exactly four digits', () => {
  assert.equal(parseHandle('Sprite#041'), null);
  assert.equal(parseHandle('Sprite#04170'), null);
  assert.equal(parseHandle('Sprite#abcd'), null);
  assert.equal(parseHandle('Sprite#'), null);
});

test('parseHandle refuses a string with no separator at all', () => {
  assert.equal(parseHandle('Sprite'), null);
  assert.equal(parseHandle(''), null);
});

test('parseHandle tolerates surrounding whitespace, because handles are pasted', () => {
  assert.deepEqual(parseHandle('  Sprite#0417 '), { pseudo: 'Sprite', discriminator: '0417' });
});

test('formatHandle and parseHandle are inverses', () => {
  const handle = formatHandle('Sprite', '0417');
  assert.equal(handle, 'Sprite#0417');
  assert.deepEqual(parseHandle(handle), { pseudo: 'Sprite', discriminator: '0417' });
});
