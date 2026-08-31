/**
 * What an import is allowed to do to saves that are already there.
 *
 * `Save_gameId_slotNumber_key` is unique, so importing into an account that
 * already uses slot 3 has to overwrite, renumber or refuse. The wrong choice
 * destroys a save silently, which is the one failure a feature about
 * safekeeping cannot have - so the rule here is that an import only ever adds:
 * savestates are renumbered onto free slots, and the single battery SRAM,
 * which cannot be renumbered because there is exactly one per cartridge, is
 * left alone unless the player has explicitly asked for it to be replaced.
 *
 * Pure, because nothing in this repository can drive an Express route in a
 * test and a policy written inline in the handler is a policy nobody can prove.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planGameImport, type ExistingGameState } from '../src/saves/import-plan.js';
import type { ArchiveGame, ArchiveState } from '../src/saves/archive.js';

const state = (over: Partial<ArchiveState> = {}): ArchiveState => ({
  name: 'Avant le boss',
  slotNumber: 1,
  data: 'AAAA',
  screenshot: null,
  createdAt: '2026-08-19T10:00:00.000Z',
  updatedAt: '2026-08-19T10:00:00.000Z',
  ...over
});

const incoming = (states: ArchiveState[], sram: string | null = null): ArchiveGame => ({
  crc32: 'AABBCCDD',
  title: 'G',
  filename: 'g.sfc',
  sram,
  sramUpdatedAt: sram ? '2026-08-20T10:00:00.000Z' : null,
  states
});

const NOTHING_YET: ExistingGameState = { saves: [], hasSram: false };

/* ------------------------------------------------------------------- slots */

test('into an empty game, the incoming slots are taken as they come', () => {
  const plan = planGameImport(incoming([state({ slotNumber: 3 }), state({ slotNumber: 7, createdAt: '2026-08-19T11:00:00.000Z' })]), NOTHING_YET, { replaceSram: false });

  assert.deepEqual(plan.states.map(s => s.slotNumber), [1, 2]);
});

/*
 * The trap. The incoming file says slot 3 and the account already has a slot 3
 * holding an hour of somebody's evening. Renumbering costs a slot number
 * nobody reads; overwriting costs the evening.
 */
test('a slot the account already uses is renumbered, never overwritten', () => {
  const existing: ExistingGameState = {
    saves: [{ name: 'mine', slotNumber: 3, createdAt: '2026-01-01T00:00:00.000Z' }],
    hasSram: false
  };

  const plan = planGameImport(incoming([state({ slotNumber: 3 })]), existing, { replaceSram: false });

  assert.equal(plan.states.length, 1);
  assert.notEqual(plan.states[0].slotNumber, 3, 'slot 3 is somebody else\'s evening');
  assert.equal(plan.states[0].slotNumber, 4, 'and it goes above the highest, not into a gap');
});

/*
 * `nextFreeSlot` in db/saves.ts never reuses a gap left by a deletion, on
 * purpose: two savestates sharing a slot number would make any old log line
 * ambiguous. An import that filled the gaps would undo that.
 */
test('renumbering goes above the highest slot rather than filling deleted gaps', () => {
  const existing: ExistingGameState = {
    saves: [
      { name: 'a', slotNumber: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      { name: 'b', slotNumber: 9, createdAt: '2026-01-01T00:00:00.000Z' }
    ],
    hasSram: false
  };

  const plan = planGameImport(
    incoming([state(), state({ createdAt: '2026-08-19T11:00:00.000Z' })]),
    existing,
    { replaceSram: false }
  );

  assert.deepEqual(plan.states.map(s => s.slotNumber), [10, 11]);
});

/*
 * Two states in one file that both claim slot 1 would violate the unique index
 * against each other, not just against what is already stored.
 */
test('two incoming states claiming the same slot do not collide with each other', () => {
  const plan = planGameImport(
    incoming([state({ slotNumber: 1 }), state({ slotNumber: 1, createdAt: '2026-08-19T11:00:00.000Z' })]),
    NOTHING_YET,
    { replaceSram: false }
  );

  assert.equal(new Set(plan.states.map(s => s.slotNumber)).size, 2);
});

/* --------------------------------------------------------------- duplicates */

/*
 * A player who imports the same file twice - because they were not sure it
 * worked the first time, which is exactly what someone does with a feature
 * they do not yet trust - must not end up with two of everything.
 */
test('importing the same file twice adds nothing the second time', () => {
  const first = planGameImport(incoming([state()]), NOTHING_YET, { replaceSram: false });
  const stored: ExistingGameState = {
    saves: first.states.map(s => ({
      name: s.state.name, slotNumber: s.slotNumber, createdAt: s.state.createdAt
    })),
    hasSram: false
  };

  const second = planGameImport(incoming([state()]), stored, { replaceSram: false });

  assert.equal(second.states.length, 0);
  assert.equal(second.duplicates, 1, 'and it is reported, not silently dropped');
});

test('a save that shares a name but not a moment is not a duplicate', () => {
  const existing: ExistingGameState = {
    saves: [{ name: 'Avant le boss', slotNumber: 1, createdAt: '2026-01-01T00:00:00.000Z' }],
    hasSram: false
  };

  const plan = planGameImport(incoming([state()]), existing, { replaceSram: false });

  assert.equal(plan.states.length, 1);
});

/* -------------------------------------------------------------------- SRAM */

test('a battery save arrives when the account has none', () => {
  const plan = planGameImport(incoming([], 'AAAA'), NOTHING_YET, { replaceSram: false });

  assert.equal(plan.sram, 'write');
});

/*
 * There is exactly one SRAM per cartridge, so it is the one thing an import
 * cannot renumber out of the way. Default is to keep what is there and say so.
 */
test('a battery save does not overwrite one that already exists', () => {
  const plan = planGameImport(incoming([], 'AAAA'), { saves: [], hasSram: true }, { replaceSram: false });

  assert.equal(plan.sram, 'kept', 'the player is told, rather than losing an in-game save');
});

test('and it does overwrite when the player asked for exactly that', () => {
  const plan = planGameImport(incoming([], 'AAAA'), { saves: [], hasSram: true }, { replaceSram: true });

  assert.equal(plan.sram, 'write');
});

test('a file with no battery save leaves the existing one alone even when replacing', () => {
  const plan = planGameImport(incoming([], null), { saves: [], hasSram: true }, { replaceSram: true });

  assert.equal(plan.sram, 'none', 'nothing to write is not the same as write nothing');
});

/* ------------------------------------------------------------- new account */

test('a game the account has never seen is planned as a creation', () => {
  const plan = planGameImport(incoming([state()], 'AAAA'), null, { replaceSram: false });

  assert.equal(plan.createsGame, true);
  assert.equal(plan.states.length, 1);
  assert.equal(plan.states[0].slotNumber, 1);
  assert.equal(plan.sram, 'write');
});
