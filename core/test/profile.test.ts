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
import { pickerError } from '../../frontend/src/lib/roms/picker-error.js';
import { romFileProblem } from '../../frontend/src/lib/roms/rom-file.js';
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

  writeShaderPreference(storage, 'xbrz/6xbrz-linear');

  assert.equal(storage.data.get('psnes-shader'), 'xbrz/6xbrz-linear');
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

test('a preset that was removed from the list is refused, not stored', () => {
  // crt-easymode was dropped on the owner's call, and xbrz-freescale before it
  // for producing framebuffer errors. Either reappearing in a profile must be
  // treated as unknown - which is also what stops a test from quietly
  // resurrecting one.
  const storage = fakeStorage();

  writeShaderPreference(storage, 'crt/crt-easymode');

  assert.equal(storage.data.has('psnes-shader'), false);
});

test('a cancelled directory picker is not reported as an error', () => {
  // Escape or Cancel on showDirectoryPicker rejects with a DOMException named
  // AbortError - a decision, not a failure.
  const err = { name: 'AbortError', message: 'The user aborted a request.' };

  assert.equal(pickerError(err), null);
});

test('a real Error is reported with its message', () => {
  const err = new Error('storedDirectory failed');

  assert.equal(pickerError(err), 'storedDirectory failed');
});

test('a non-Error value is reported as its stringification', () => {
  assert.equal(pickerError('disk unplugged'), 'disk unplugged');
});

test('an Error about aborting is still reported unless its name is AbortError', () => {
  // The function is keyed on the name, not on message text that happens to
  // mention aborting.
  const err = new Error('the request was aborted by the network layer');

  assert.equal(pickerError(err), 'the request was aborted by the network layer');
});

const MAX_ROM_BYTES = 8 * 1024 * 1024;

test('an accepted extension under the size cap passes', () => {
  assert.equal(romFileProblem('Chrono Trigger.sfc', 1024), null);
});

test('a rejected extension is reported as an invalid type', () => {
  assert.equal(romFileProblem('setup.exe', 1024), 'romInvalidType');
});

test('a file one byte over the cap is too large', () => {
  assert.equal(romFileProblem('Chrono Trigger.sfc', MAX_ROM_BYTES + 1), 'romTooLarge');
});

test('a file exactly at the cap is accepted', () => {
  assert.equal(romFileProblem('Chrono Trigger.sfc', MAX_ROM_BYTES), null);
});

test('an uppercase extension is accepted, matching the lowercased comparison', () => {
  // The old modal lowercased the extension before comparing; losing that
  // would reject a file it used to take.
  assert.equal(romFileProblem('Chrono Trigger.SFC', 1024), null);
});
