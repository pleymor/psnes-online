/**
 * Les couleurs du monde, en un seul endroit.
 *
 * Le test ne juge pas le goût - il tient la FORME. Une couleur mal écrite
 * (`#fff`, `rgb(...)`, une majuscule) traverserait `pixels.ts` sans bruit et
 * ressortirait en pixels noirs dans le casque, à des heures de sa cause.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { COLOURS } from '../../frontend/src/lib/vr/decor/palette.js';

test('toute couleur est un hex à six chiffres, en minuscules', () => {
  for (const [name, value] of Object.entries(COLOURS)) {
    assert.match(value, /^#[0-9a-f]{6}$/, `${name} vaut ${value}`);
  }
});

test('la palette n_est pas vide et porte le ciel de SMB', () => {
  assert.ok(Object.keys(COLOURS).length >= 8);
  assert.equal(COLOURS.sky, '#5c94fc');
});
