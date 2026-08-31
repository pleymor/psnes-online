/**
 * The two copies of the pseudonym rule, held against each other.
 *
 * backend/src/utils/pseudo.ts is the authority; frontend/src/lib/pseudo.ts is
 * a convenience so the input can complain while it is being typed. There is no
 * module the two could share - `core/` is the wasm emulator, and the
 * frontend's Docker build context is pinned by the infrastructure repo - so
 * the rule is written twice on purpose.
 *
 * Twice is fine. Silently diverging is not, and that is what this file is for:
 * the tests run from the repository root, so a single file can import both
 * sides. The Docker separation governs how images are built, not how tests
 * run - core/test/profile.test.ts has been importing across for a while.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import * as server from '../src/utils/pseudo.js';
import * as browser from '../../frontend/src/lib/pseudo.js';

/** Everything either copy could plausibly disagree about. */
const PSEUDONYMS = [
  'abc', 'Sprite', 'a-b_C9', 'A'.repeat(16), 'Mode7', '0000',
  'ab', '', 'A'.repeat(17),
  'Émile', 'Мario', 'naïve', '日本',
  'two words', ' Sprite', 'Sprite ', 'Spri#te', 'a.b', 'a+b', 'a/b',
  'sprite', 'SPRITE'
];

const HANDLES = [
  'Sprite#0417', 'sprite#0417', 'a-b_C9#0000', '  Sprite#0417 ',
  'Sprite', '', '#0417', 'Sprite#', 'Sprite#041', 'Sprite#04170',
  'Sprite#abcd', 'a#b#0001', 'Émile#0001', 'ab#0001'
];

test('both copies accept and refuse exactly the same pseudonyms', () => {
  for (const candidate of PSEUDONYMS) {
    assert.equal(
      browser.isValidPseudo(candidate),
      server.isValidPseudo(candidate),
      `the two rules disagree about ${JSON.stringify(candidate)}`
    );
  }
});

test('both copies parse handles the same way', () => {
  for (const candidate of HANDLES) {
    assert.deepEqual(
      browser.parseHandle(candidate),
      server.parseHandle(candidate),
      `the two parsers disagree about ${JSON.stringify(candidate)}`
    );
  }
});

test('both copies build the same handle string', () => {
  assert.equal(browser.formatHandle('Sprite', '0417'), server.formatHandle('Sprite', '0417'));
});

test('the shared bounds the browser advertises match the rule it enforces', () => {
  // The modal shows these numbers to the player. If they drifted from the
  // pattern, the field would promise something the server refuses.
  assert.equal(browser.isValidPseudo('a'.repeat(browser.PSEUDO_MIN)), true);
  assert.equal(browser.isValidPseudo('a'.repeat(browser.PSEUDO_MIN - 1)), false);
  assert.equal(browser.isValidPseudo('a'.repeat(browser.PSEUDO_MAX)), true);
  assert.equal(browser.isValidPseudo('a'.repeat(browser.PSEUDO_MAX + 1)), false);
});
