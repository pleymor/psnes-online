/**
 * What a tab remembers about the room it is in, and when it refuses to.
 *
 * The note exists because a room of one dies with its player's socket and a
 * reload closes that socket: the reloaded page arrives holding a room id the
 * server has already forgotten, and the game - the one thing needed to rebuild
 * it - is not in the URL. The rules worth pinning are the refusals, because
 * they are what stop a convenience becoming a room appearing out of nowhere.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import {
  rememberRoom,
  recallRoom,
  forgetRoom,
  type RoomStore
} from '../../frontend/src/lib/rooms/remembered-room.js';

/** A `sessionStorage` that is just an object, so these run under node. */
function store(seed: Record<string, string> = {}): RoomStore & { data: Record<string, string> } {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    }
  };
}

const ROOM = { roomId: 'r1', gameId: 'g1', gameTitle: 'Secret of Mana' };

test('a tab recalls the room it remembered', () => {
  const s = store();
  rememberRoom(ROOM, s);
  assert.deepEqual(recallRoom('r1', s), ROOM);
});

test('the note is only good for the room it names', () => {
  // The id check is the whole guard against a hand-typed URL for a room that
  // never existed being answered with somebody else's cartridge.
  const s = store();
  rememberRoom(ROOM, s);
  assert.equal(recallRoom('some-other-room', s), null);
});

test('nothing remembered means nothing to rebuild', () => {
  assert.equal(recallRoom('r1', store()), null);
});

test('forgetting is what a deliberate departure does', () => {
  // Without this, quitting and then pressing Back would rebuild the room the
  // player had just chosen to leave.
  const s = store();
  rememberRoom(ROOM, s);
  forgetRoom(s);
  assert.equal(recallRoom('r1', s), null);
});

test('a note that cannot be read is a note we do not have', () => {
  // Half-written, hand-edited, or left by an older version of this code.
  for (const raw of ['not json at all', '{}', 'null', '{"roomId":"r1"}', '[]']) {
    const s = store({ 'psnes:room': raw });
    assert.equal(recallRoom('r1', s), null, `refused: ${raw}`);
  }
});

test('a store that throws leaves the page working', () => {
  // Private windows and blocked site data do not merely return empty - the
  // access itself throws, and it must not take the room page down with it.
  const hostile: RoomStore = {
    getItem() {
      throw new Error('site data blocked');
    },
    setItem() {
      throw new Error('site data blocked');
    },
    removeItem() {
      throw new Error('site data blocked');
    }
  };
  assert.equal(recallRoom('r1', hostile), null);
  assert.doesNotThrow(() => rememberRoom(ROOM, hostile));
  assert.doesNotThrow(() => forgetRoom(hostile));
});
