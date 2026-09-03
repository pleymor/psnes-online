/**
 * The two locales carry the same keys.
 *
 * This is NOT the compiler's job, despite appearances - and the appearance is
 * worth spelling out, because it is what nearly made this file redundant.
 *
 * `t()` reads `translations[lang][key]`. `translations[lang]` is a union of the
 * two locale objects, and indexing a union demands the key exist on both
 * members, so a key added to `en` and forgotten in `fr` really is a type error
 * today - measured, not assumed: removing one French key takes svelte-check
 * from 0 errors to 1.
 *
 * But that protection is ACCIDENTAL. It is a side effect of how `t()` happens
 * to be written, not a rule anybody stated. Narrow the lookup to
 * `translations.en[key]`, or annotate the locale as a
 * `Record<TranslationKey, string>`, and it evaporates silently - the code still
 * compiles, and French speakers start reading English. This test states the
 * invariant so it survives a refactor of `t()`.
 *
 * And the other direction was never covered at all: `TranslationKey` derives
 * from `translations.en`, so a French-only key is unreachable and the compiler
 * says nothing. Measured too - adding one keeps svelte-check at 0 errors. That
 * is how a mistyped key hides: the correct spelling goes missing from French
 * (caught), and were the lookup ever loosened, the typo would sit there
 * unread and unreported.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { translations } from '../../frontend/src/lib/i18n/translations.js';

test('every English key has a French one', () => {
  const fr = new Set(Object.keys(translations.fr));
  const missing = Object.keys(translations.en).filter((key) => !fr.has(key));

  assert.deepEqual(
    missing,
    [],
    `these keys exist in English only, so a French player reads English: ${missing.join(', ')}`
  );
});

test('no French key is an orphan', () => {
  // `TranslationKey` comes from the English locale, so nothing can ever ask
  // for these - they are dead strings, and usually a typo of a real key.
  const en = new Set(Object.keys(translations.en));
  const orphans = Object.keys(translations.fr).filter((key) => !en.has(key));

  assert.deepEqual(
    orphans,
    [],
    `these French keys can never be read, and are usually a misspelling: ${orphans.join(', ')}`
  );
});

test('no translation is empty', () => {
  // An empty string passes every check above and every type check, and shows
  // the player nothing at all - `t()`'s `||` fallback treats it as absent, so
  // English leaks through for French and the key name itself for English.
  const blank: string[] = [];
  for (const [lang, table] of Object.entries(translations)) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== 'string' || value.trim() === '') blank.push(`${lang}.${key}`);
    }
  }
  assert.deepEqual(blank, [], `empty translations: ${blank.join(', ')}`);
});
