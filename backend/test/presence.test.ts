/**
 * Presence, as a pure decision.
 *
 * A member who is offline is still a member: their seat is theirs, they hold
 * their port, and nobody may take either. What they cannot do is be counted
 * as someone a game can start against. These tests fix that distinction,
 * which four call sites depend on and none of them can express in a type.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { onlinePlayers } from '../src/rooms/online-players.js';
import { ABANDON_AFTER_MS, abandonedRoomIds, isAbandoned } from '../src/rooms/abandonment.js';

const player = (userId: string, online: boolean) =>
  ({ userId, displayName: userId, port: null, isReady: true, emulationReady: false, online }) as never;

test('only the players who are here are counted', () => {
  const room = { players: [player('alice', true), player('bob', false)] };
  assert.deepEqual(onlinePlayers(room as never).map(p => p.userId), ['alice']);
});

test('a room where nobody is here counts nobody, and does not throw', () => {
  const room = { players: [player('alice', false), player('bob', false)] };
  assert.deepEqual(onlinePlayers(room as never), []);
});

/*
 * Rooms read back from a snapshot written before this field existed have no
 * `online` at all. Absent must mean offline: counting `undefined` as present
 * would let a game start against a player who is not there, which is the exact
 * failure this whole module exists to prevent.
 */
test('a player restored without the field is treated as away, not as present', () => {
  const room = { players: [{ userId: 'alice', port: 1, isReady: true }] };
  assert.deepEqual(onlinePlayers(room as never), []);
});

// --- when a room nobody is in has waited long enough ------------------------

const AT = new Date('2026-08-23T20:00:00.000Z');
const ago = (ms: number) => new Date(AT.getTime() - ms);

test('a room somebody is still in is never abandoned', () => {
  assert.equal(isAbandoned({}, AT), false);
});

test('a room abandoned less than the deadline ago survives', () => {
  assert.equal(isAbandoned({ abandonedAt: ago(ABANDON_AFTER_MS - 1) }, AT), false);
});

/*
 * The exact instant, on its own line.
 *
 * `>=` and `>` differ by one millisecond and by nothing a reader would notice,
 * which is why the boundary gets a test of its own rather than being implied by
 * the two either side of it. The invitation deadline has the same test for the
 * same reason.
 */
test('a room abandoned exactly the deadline ago is abandoned', () => {
  assert.equal(isAbandoned({ abandonedAt: ago(ABANDON_AFTER_MS) }, AT), true);
});

test('twelve hours is the deadline', () => {
  assert.equal(ABANDON_AFTER_MS, 12 * 60 * 60_000);
});

test('the sweep names the abandoned rooms and leaves the others alone', () => {
  const rooms = new Map<string, never>([
    ['live', { id: 'live', abandonedAt: undefined } as never],
    ['recent', { id: 'recent', abandonedAt: ago(60_000) } as never],
    ['stale', { id: 'stale', abandonedAt: ago(ABANDON_AFTER_MS + 1) } as never]
  ]);

  assert.deepEqual(abandonedRoomIds(rooms as never, AT), ['stale']);
});
