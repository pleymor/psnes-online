/**
 * Le mapping VR : une permutation, pas un preset.
 *
 * L'invariant que ce fichier existe pour tenir est l'injectivité. Huit boutons
 * SNES, neuf entrées Touch, et jamais deux boutons sur la même : un bouton sans
 * entrée est injouable, et un casque n'a ni console ni logs lisibles pour le
 * dire. C'est pourquoi le conflit s'échange au lieu de voler.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  LETTERS_MAP,
  THUMB_MAP,
  VR_PAD_KEY,
  readPadMap,
  writePadMap,
  assignInput,
  type VrPadMap
} from '../../frontend/src/lib/vr/pad-map.js';

/** Le `PreferenceStorage` minimal, en mémoire. */
function storage(initial: Record<string, string> = {}) {
  const held = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => { held.set(key, value); },
    removeItem: (key: string) => { held.delete(key); },
    held
  };
}

const BUTTONS = ['a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'] as const;

function isInjective(map: VrPadMap): boolean {
  return new Set(BUTTONS.map((b) => map[b])).size === BUTTONS.length;
}

test('les deux presets sont des permutations complètes', () => {
  for (const [name, map] of [['letters', LETTERS_MAP], ['thumb', THUMB_MAP]] as const) {
    assert.equal(Object.keys(map).length, 8, `${name} n'a pas huit lignes`);
    assert.ok(isInjective(map), `${name} assigne deux boutons à la même entrée`);
  }
});

test('assigner une entrée libre ne déplace rien', () => {
  // Le clic du stick gauche est la neuvième entrée, celle qu'aucun preset
  // n'utilise. La prendre ne peut rien déloger.
  const next = assignInput(LETTERS_MAP, 'a', 'XrLeftStickClick');
  assert.equal(next.a, 'XrLeftStickClick');
  for (const button of BUTTONS) {
    if (button === 'a') continue;
    assert.equal(next[button], LETTERS_MAP[button], `${button} a bougé sans raison`);
  }
});

test('assigner une entrée déjà prise échange les deux lignes', () => {
  const held = LETTERS_MAP.r;
  const gave = LETTERS_MAP.a;
  const next = assignInput(LETTERS_MAP, 'a', held);

  assert.equal(next.a, held, "la ligne demandée n'a pas reçu son entrée");
  assert.equal(next.r, gave, "l'ancienne ligne n'a pas reçu l'entrée libérée");
  assert.ok(isInjective(next), "l'échange a cassé l'injectivité");
});

test('assigner à un bouton ce qu il a déjà ne change rien', () => {
  const next = assignInput(LETTERS_MAP, 'a', LETTERS_MAP.a);
  assert.deepEqual(next, LETTERS_MAP);
});

test('aucune suite d assignations ne peut casser l injectivité', () => {
  // Exhaustif plutôt qu'anecdotique : c'est l'invariant du modèle, et une
  // seule paire (bouton, entrée) qui le casse rend un bouton injouable.
  const INPUTS = [
    'XrLeftTrigger', 'XrRightTrigger', 'XrLeftSqueeze', 'XrRightSqueeze',
    'XrLeftFaceUpper', 'XrRightFaceUpper', 'XrLeftFaceLower', 'XrRightFaceLower',
    'XrLeftStickClick'
  ] as const;

  let map: VrPadMap = LETTERS_MAP;
  for (const button of BUTTONS) {
    for (const input of INPUTS) {
      map = assignInput(map, button, input);
      assert.equal(map[button], input, `${button} n'a pas pris ${input}`);
      assert.ok(isInjective(map), `${button} := ${input} a cassé l'injectivité`);
    }
  }
});

test('rien de stocké rend le défaut', () => {
  assert.deepEqual(readPadMap(storage()), LETTERS_MAP);
});

test('une valeur héritée letters ou thumb se résout vers sa map', () => {
  // Des joueurs ont déjà ces chaînes sous la clé : les rejeter leur reprendrait
  // le réglage qu'ils avaient choisi.
  assert.deepEqual(readPadMap(storage({ [VR_PAD_KEY]: 'letters' })), LETTERS_MAP);
  assert.deepEqual(readPadMap(storage({ [VR_PAD_KEY]: 'thumb' })), THUMB_MAP);
});

test('une valeur illisible est retirée et rend le défaut', () => {
  for (const junk of ['{', 'nonsense', '{"a":"XrNope"}', '{"a":"XrLeftTrigger"}']) {
    const store = storage({ [VR_PAD_KEY]: junk });
    assert.deepEqual(readPadMap(store), LETTERS_MAP, `${junk} n'a pas rendu le défaut`);
    assert.equal(store.held.has(VR_PAD_KEY), false, `${junk} est resté stocké`);
  }
});

test('une map non injective stockée à la main est refusée', () => {
  const broken = { ...LETTERS_MAP, a: LETTERS_MAP.r };
  const store = storage({ [VR_PAD_KEY]: JSON.stringify(broken) });
  assert.deepEqual(readPadMap(store), LETTERS_MAP);
  assert.equal(store.held.has(VR_PAD_KEY), false);
});

test('le défaut est retiré plutôt qu écrit', () => {
  const store = storage({ [VR_PAD_KEY]: 'thumb' });
  writePadMap(store, LETTERS_MAP);
  assert.equal(store.held.has(VR_PAD_KEY), false, "le défaut ne doit pas être stocké");
});

test('une map non-défaut est écrite et se relit identique', () => {
  const store = storage();
  const custom = assignInput(LETTERS_MAP, 'a', 'XrLeftStickClick');
  writePadMap(store, custom);
  assert.deepEqual(readPadMap(store), custom);
});
