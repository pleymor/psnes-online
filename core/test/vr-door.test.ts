/**
 * The folder permission asked for at the door.
 *
 * Two rules here are load-bearing rather than cosmetic, and both were learned
 * the expensive way.
 *
 * `folderNeedsGrant` must never ask. It runs from `onMount`, where there is no
 * user gesture, and `requestPermission` off a gesture does not resolve to
 * 'denied' - it rejects with a SecurityError. Asking there is how the previous
 * version of this story broke: a function that promised silence, asked anyway,
 * and ejected the player from the headset.
 *
 * And nothing here may bar the door. Every failure resolves towards entering
 * VR, because a device with no picker keeps its games in IndexedDB and needs
 * no permission at all, while a wrong "yes, ask" costs a press for a dialog
 * that will never appear.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  folderNeedsGrant,
  grantFolder,
  type DoorPorts
} from '../../frontend/src/lib/vr/door.js';

const HANDLE = {} as FileSystemDirectoryHandle;

function ports(over: Partial<DoorPorts> = {}): DoorPorts {
  return {
    supportsDirectoryPicker: () => true,
    storedDirectory: async () => HANDLE,
    hasAccess: async () => true,
    ensureAccess: async () => true,
    ...over
  };
}

test('a folder whose permission has lapsed needs the press', async () => {
  assert.equal(await folderNeedsGrant(ports({ hasAccess: async () => false })), true);
});

test('a folder already granted does not', async () => {
  assert.equal(await folderNeedsGrant(ports()), false);
});

test('no folder, no grant to ask for', async () => {
  assert.equal(await folderNeedsGrant(ports({ storedDirectory: async () => undefined })), false);
});

test('a browser with no picker keeps its games where no permission is needed', async () => {
  assert.equal(
    await folderNeedsGrant(ports({ supportsDirectoryPicker: () => false, hasAccess: async () => false })),
    false
  );
});

test('the check never asks - there is no gesture on mount', async () => {
  // Not a style point. `requestPermission` without transient activation
  // rejects rather than returning 'denied', and this function runs from
  // onMount.
  let asked = false;
  await folderNeedsGrant(
    ports({
      hasAccess: async () => false,
      ensureAccess: async () => {
        asked = true;
        return true;
      }
    })
  );
  assert.equal(asked, false, 'folderNeedsGrant asked for a permission with no gesture to spend');
});

test('a check that throws lets the player in anyway', async () => {
  for (const broken of [
    { storedDirectory: async () => { throw new Error('indexeddb is blocked'); } },
    { hasAccess: async () => { throw new Error('no queryPermission here'); } }
  ]) {
    assert.equal(
      await folderNeedsGrant(ports(broken as Partial<DoorPorts>)),
      false,
      'a broken check must not be what stops somebody entering VR'
    );
  }
});

test('a press on an already-granted folder shows no dialog and enters', async () => {
  // The state is read on mount and the world moves: the flat page may have
  // re-granted the folder since. Charging a second press for a dialog nobody
  // saw would be a bug the player could not explain.
  let asked = false;
  const outcome = await grantFolder(
    ports({
      ensureAccess: async () => {
        asked = true;
        return true;
      }
    })
  );
  assert.equal(outcome, 'entered');
  assert.equal(asked, false, 'a dialog was raised for a permission that was already there');
});

test('a press that wins the permission asks for a second one', async () => {
  // `granted`, not `entered`: the dialog spent the activation that
  // requestSession needs, so the caller must not try to open a session now.
  const outcome = await grantFolder(ports({ hasAccess: async () => false, ensureAccess: async () => true }));
  assert.equal(outcome, 'granted');
});

test('a refusal says so, so the caller can explain rather than enter blind', async () => {
  const outcome = await grantFolder(ports({ hasAccess: async () => false, ensureAccess: async () => false }));
  assert.equal(outcome, 'refused');
});

test('a press on a folderless device enters instead of refusing', async () => {
  assert.equal(await grantFolder(ports({ storedDirectory: async () => undefined })), 'entered');
});

test('a throw while granting is not a refusal', async () => {
  assert.equal(
    await grantFolder(ports({ hasAccess: async () => { throw new Error('gone'); } })),
    'entered',
    'the door stays open; the library panel is where an unreadable ROM gets explained'
  );
});
