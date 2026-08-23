/**
 * Finding the entry a player means.
 *
 * The ranking is the whole feature: the client seeds the query with the game's
 * current title, so in the ordinary case the right entry has to come back
 * first and the player's whole job is one click. A search that finds the right
 * answer and puts it ninth has failed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCatalogue, SEARCH_LIMIT } from '../src/services/catalogue-search.js';
import type { GameMetadata } from '../src/db/types.js';

function entry(over: Partial<GameMetadata>): GameMetadata {
  return {
    id: over.id ?? 'x', title: over.title ?? 'A Game', altTitle: over.altTitle ?? null,
    genre: null, publisher: over.publisher ?? null, developer: null,
    releaseDate: over.releaseDate ?? null, players: null, region: over.region ?? null,
    description: null, coverUrl: over.coverUrl ?? null, crc32: null, md5: null,
    source: over.source ?? 'catalogue', contributedBy: null, hasCover: false,
    createdAt: new Date(0), updatedAt: new Date(0)
  };
}

test('an exact title comes before a prefix, which comes before a mere mention', () => {
  const entries = [
    entry({ id: 'mention', title: 'The Legend of Super Mario World' }),
    entry({ id: 'exact', title: 'Super Mario World' }),
    entry({ id: 'prefix', title: 'Super Mario World Deluxe' })
  ];

  const ranked = rankCatalogue(entries, 'Super Mario World');

  assert.deepEqual(ranked.map(m => m.id), ['exact', 'prefix', 'mention']);
});

test('the filename a player actually has still finds the game', () => {
  // normalizeTitle strips the extension and the region tag, which is what
  // makes a raw filename a usable query.
  const entries = [entry({ id: 'sm', title: 'Super Metroid' })];

  assert.equal(rankCatalogue(entries, 'Super Metroid (USA).sfc')[0].id, 'sm');
});

test('a japanese alternate title matches too', () => {
  const entries = [entry({ id: 'act', title: 'ActRaiser', altTitle: 'アクトレイザー' })];

  assert.equal(rankCatalogue(entries, 'アクトレイザー')[0].id, 'act');
});

test('a query too short to mean anything returns nothing', () => {
  const entries = [entry({ id: 'a', title: 'A Game' })];

  // One letter would match most of the catalogue and order it arbitrarily.
  assert.deepEqual(rankCatalogue(entries, 'a'), []);
  assert.deepEqual(rankCatalogue(entries, ''), []);
});

test('no match is an empty list, not a wrong guess', () => {
  const entries = [entry({ id: 'sm', title: 'Super Metroid' })];

  assert.deepEqual(rankCatalogue(entries, 'Pilotwings'), []);
});

test('the result set is capped', () => {
  const entries = Array.from({ length: 50 }, (_, i) => entry({ id: `g${i}`, title: `Contra ${i}` }));

  assert.equal(rankCatalogue(entries, 'Contra').length, SEARCH_LIMIT);
});

test('a match carries what the player needs to tell two entries apart', () => {
  const entries = [entry({
    id: 'sm', title: 'Super Metroid', region: 'NTSC', publisher: 'Nintendo',
    releaseDate: '1994-03-19', coverUrl: '/api/covers/sm?v=1', source: 'community'
  })];

  const [match] = rankCatalogue(entries, 'Super Metroid');

  assert.deepEqual(match, {
    id: 'sm', title: 'Super Metroid', altTitle: null, region: 'NTSC',
    publisher: 'Nintendo', releaseDate: '1994-03-19',
    coverUrl: '/api/covers/sm?v=1', source: 'community'
  });
});
