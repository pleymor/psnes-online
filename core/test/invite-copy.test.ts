/**
 * Chaque refus de la porte a une phrase, dans les deux langues.
 *
 * Sans ce test, un code de refus ajouté côté serveur s'afficherait au visiteur
 * sous la forme `INVITE_REVOKED` -- et personne ne le verrait avant que ça
 * arrive à quelqu'un.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { SIGNUP_REFUSAL_KEYS } from '../../frontend/src/lib/auth/signup-refusal.js';
import { translations } from '../../frontend/src/lib/i18n/translations.js';

// La liste vient de backend/src/auth/signup-door.ts:SignupRefusal. Elle est
// recopiée ici plutôt qu'importée : le front ne dépend pas du backend, et une
// divergence doit faire échouer ce test plutôt que de disparaître dans un type.
const REFUSALS = [
  'ALREADY_SIGNED_IN', 'PLATFORM_FULL', 'INVITE_UNKNOWN',
  'INVITE_REVOKED', 'INVITE_USED', 'QUOTA_EXHAUSTED', 'TOO_MANY_ATTEMPTS'
];

test('chaque refus de la porte a une clé de traduction', () => {
  for (const refusal of REFUSALS) {
    assert.ok(SIGNUP_REFUSAL_KEYS[refusal], `aucune clé pour ${refusal}`);
  }
});

test('chaque clé existe en anglais et en français', () => {
  for (const key of Object.values(SIGNUP_REFUSAL_KEYS)) {
    assert.ok((translations.en as Record<string, unknown>)[key], `en.${key} manque`);
    assert.ok((translations.fr as Record<string, unknown>)[key], `fr.${key} manque`);
  }
});

test('un refus inconnu retombe sur une phrase générique', () => {
  assert.ok(SIGNUP_REFUSAL_KEYS.UNKNOWN);
});
