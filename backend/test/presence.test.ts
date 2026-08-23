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
