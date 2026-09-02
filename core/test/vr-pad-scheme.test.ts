/**
 * Which of the two Touch presets a player chose.
 *
 * The SNES has four action buttons in a diamond under one thumb; the Touch
 * controllers have four in two vertical pairs, one per hand. There is no
 * natural correspondence, so there are two presets, and `letters` is the
 * default because "press B" naming the button marked B surprises nobody.
 *
 * The storage rules are `shader-preference.ts`'s, for its reasons: an unknown
 * value is purged on read rather than returned, and the key is removed rather
 * than emptied so no reader has to treat '' and absent as the same thing.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  readPadScheme,
  writePadScheme,
  VR_PAD_KEY
} from '../../frontend/src/lib/vr/pad-scheme.js';

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    seen: () => [...map.entries()]
  };
}

test('an untouched machine gets the letters preset', () => {
  assert.equal(readPadScheme(fakeStorage()), 'letters');
});

test('a stored preset comes back', () => {
  assert.equal(readPadScheme(fakeStorage({ [VR_PAD_KEY]: 'thumb' })), 'thumb');
});

test('an unknown value is purged rather than returned', () => {
  const storage = fakeStorage({ [VR_PAD_KEY]: 'southpaw' });
  assert.equal(readPadScheme(storage), 'letters');
  assert.deepEqual(storage.seen(), [], 'a value no reader accepts is worse than no value');
});

test('writing the default removes the key rather than storing it', () => {
  const storage = fakeStorage({ [VR_PAD_KEY]: 'thumb' });
  writePadScheme(storage, 'letters');
  assert.deepEqual(storage.seen(), [], 'absent and default must be one state, not two');
  assert.equal(readPadScheme(storage), 'letters');
});

test('writing the non-default stores it', () => {
  const storage = fakeStorage();
  writePadScheme(storage, 'thumb');
  assert.deepEqual(storage.seen(), [[VR_PAD_KEY, 'thumb']]);
});
