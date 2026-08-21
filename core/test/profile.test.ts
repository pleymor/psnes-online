/**
 * The two decisions behind the profile page that can be wrong invisibly.
 *
 * Everything else in that work is layout, which this repo cannot test. These
 * two are not: which form the ROM panel takes decides whether Firefox and
 * Safari can add a game at all, and the shader preference reader replaces four
 * hand-rolled copies, one of which had forgotten to purge a stale value.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { romSourceState } from '../../frontend/src/lib/roms/source-state.js';
import {
  readShaderPreference,
  writeShaderPreference
} from '../../frontend/src/lib/stores/shader-preference.js';

/** A storage that records what was done to it. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    removed: [] as string[],
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
      this.removed.push(key);
    }
  };
}

test('a browser without the directory API is reported as unsupported', () => {
  // This is the case that decides whether Firefox and Safari can add a game.
  const state = romSourceState({ supported: false });

  assert.equal(state.kind, 'unsupported');
});

test('unsupported wins even if a folder name is somehow remembered', () => {
  // A handle stored by a previous browser, or a shared profile. The API is what
  // decides, not the leftover.
  const state = romSourceState({ supported: false, folderName: 'roms', accessGranted: true });

  assert.equal(state.kind, 'unsupported');
});

test('supported with no folder asks for one', () => {
  const state = romSourceState({ supported: true });

  assert.equal(state.kind, 'no-folder');
});

test('a folder with access is reported with its name', () => {
  const state = romSourceState({ supported: true, folderName: 'SNES', accessGranted: true });

  assert.deepEqual(state, { kind: 'folder', name: 'SNES' });
});

test('a folder whose permission has lapsed is distinguished from no folder at all', () => {
  // Different remedies: one needs a click to re-grant, the other needs a pick.
  // Collapsing them would tell the player to choose a folder they already chose.
  const state = romSourceState({ supported: true, folderName: 'SNES', accessGranted: false });

  assert.deepEqual(state, { kind: 'folder-stale', name: 'SNES' });
});

test('a folder name with no access flag is treated as stale, not granted', () => {
  // Absence of a yes is not a yes.
  const state = romSourceState({ supported: true, folderName: 'SNES' });

  assert.equal(state.kind, 'folder-stale');
});

test('a known shader id is read back', () => {
  const storage = fakeStorage({ 'psnes-shader': 'xbrz/6xbrz-linear' });

  assert.equal(readShaderPreference(storage), 'xbrz/6xbrz-linear');
});

test('no stored preference reads as no shader', () => {
  const storage = fakeStorage();

  assert.equal(readShaderPreference(storage), '');
});

test('an unknown id is purged, not returned', () => {
  // xbrz-freescale was delisted after it produced framebuffer errors. A profile
  // that still holds it must not keep costing a fetch and a notice.
  const storage = fakeStorage({ 'psnes-shader': 'xbrz/xbrz-freescale' });

  assert.equal(readShaderPreference(storage), '');
  assert.deepEqual(storage.removed, ['psnes-shader'], 'the stale value must be removed, not just ignored');
});

test('writing a shader id stores it', () => {
  const storage = fakeStorage();

  writeShaderPreference(storage, 'crt/crt-easymode');

  assert.equal(storage.data.get('psnes-shader'), 'crt/crt-easymode');
});

test('writing the empty id removes the key rather than storing an empty string', () => {
  // Otherwise the key lingers and every reader has to treat '' and absent the
  // same way, which is the sort of thing one of them will forget.
  const storage = fakeStorage({ 'psnes-shader': 'anti-aliasing/fxaa' });

  writeShaderPreference(storage, '');

  assert.equal(storage.data.has('psnes-shader'), false);
  assert.deepEqual(storage.removed, ['psnes-shader']);
});

test('writing an unknown id is refused rather than stored', () => {
  const storage = fakeStorage();

  writeShaderPreference(storage, 'not/a/shader');

  assert.equal(storage.data.has('psnes-shader'), false, 'a value no reader would accept must not be written');
});
