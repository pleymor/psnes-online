/**
 * The file a player carries their progress in, and what it refuses to swallow.
 *
 * An import is the one place in this application where a player hands the
 * server a blob and the server writes it into a row keyed by somebody's
 * account. Everything in `parseArchive` exists because the alternative is
 * trusting that file: an 800KB savestate multiplied by a claimed two thousand
 * games is a memory exhaustion, a `screenshot` that is not a data URL is an
 * `<img src>` the app renders, and a state produced by a different snes9x
 * build loads into garbage rather than failing - silent corruption of exactly
 * the progress this feature promises to keep.
 *
 * So the parser is a whitelist, not a sanity check, and the tests below are
 * written as the attacks they answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  CORE_STATE_VERSION,
  MAX_STATE_BYTES,
  MAX_SRAM_BYTES,
  MAX_STATES_PER_GAME,
  MAX_GAMES_PER_ARCHIVE,
  buildArchive,
  parseArchive,
  type ArchiveGame
} from '../src/saves/archive.js';

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

function aGame(over: Partial<ArchiveGame> = {}): ArchiveGame {
  return {
    crc32: 'AABBCCDD',
    title: 'Super Mario World',
    filename: 'smw.sfc',
    sram: b64([1, 2, 3]),
    sramUpdatedAt: '2026-08-20T10:00:00.000Z',
    states: [
      {
        name: 'Avant le boss',
        slotNumber: 3,
        data: b64([9, 9, 9, 9]),
        screenshot: 'data:image/png;base64,' + b64([1, 2, 3]),
        createdAt: '2026-08-19T10:00:00.000Z',
        updatedAt: '2026-08-19T11:00:00.000Z'
      }
    ],
    ...over
  };
}

function anArchive(over: Record<string, unknown> = {}) {
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    coreVersion: CORE_STATE_VERSION,
    exportedAt: '2026-08-30T12:00:00.000Z',
    games: [aGame()],
    ...over
  };
}

/* ------------------------------------------------------------------ shape */

test('the envelope is a list from the start, so one game is a list of one', () => {
  const archive = buildArchive([
    {
      crc32: 'AABBCCDD',
      title: 'Super Mario World',
      filename: 'smw.sfc',
      sram: Buffer.from([1, 2]),
      sramUpdatedAt: new Date('2026-08-20T10:00:00.000Z'),
      saves: []
    }
  ]);

  assert.equal(archive.format, ARCHIVE_FORMAT);
  assert.equal(archive.version, ARCHIVE_VERSION);
  assert.ok(Array.isArray(archive.games), 'a single game exports in the same shape as a library');
  assert.equal(archive.games.length, 1);
});

/*
 * `Game` rows are per-player (`Game_userId_crc32_key`), so exporting a gameId
 * would produce a file that only ever works for the account it came from -
 * which defeats the whole point of a portable save.
 */
test('a game is identified by its checksum, never by its row id', () => {
  const archive = buildArchive([
    {
      crc32: 'AABBCCDD', title: 'G', filename: 'g.sfc',
      sram: null, sramUpdatedAt: null, saves: []
    }
  ]);

  assert.equal(archive.games[0].crc32, 'AABBCCDD');
  assert.equal(
    JSON.stringify(archive).includes('gameId'), false,
    'a row id in the file would tie it to one account'
  );
});

test('the archive stamps the core build its savestates came from', () => {
  const archive = buildArchive([]);

  assert.equal(archive.coreVersion, CORE_STATE_VERSION);
});

/*
 * The whole promise of the stamp is that it names the build that actually ran.
 * A constant that drifted from core/build.sh would keep saying "compatible"
 * while the states in the file stopped being loadable - the failure this
 * feature exists to prevent, dressed up as a success.
 */
test('the stamped core version is the commit core/build.sh actually pins', () => {
  const build = readFileSync(resolve(import.meta.dirname, '../../core/build.sh'), 'utf8');
  const pinned = /SNES9X_COMMIT="([0-9a-f]{40})"/.exec(build);

  assert.ok(pinned, 'core/build.sh should still pin a commit');
  assert.equal(CORE_STATE_VERSION, `snes9x-${pinned[1]}`);
});

test('screenshots travel by default, and can be left behind', () => {
  const saves = [{
    name: 's', slotNumber: 1, data: Buffer.from([1]),
    screenshot: 'data:image/png;base64,AAA=',
    createdAt: new Date('2026-08-19T10:00:00.000Z'),
    updatedAt: new Date('2026-08-19T10:00:00.000Z')
  }];
  const game = { crc32: 'AABBCCDD', title: 'G', filename: 'g.sfc', sram: null, sramUpdatedAt: null, saves };

  assert.equal(buildArchive([game]).games[0].states[0].screenshot, 'data:image/png;base64,AAA=');
  assert.equal(
    buildArchive([game], { screenshots: false }).games[0].states[0].screenshot, null,
    'a full library is mostly PNG; leaving them out has to be possible'
  );
});

/* ----------------------------------------------------------------- parsing */

test('a well-formed archive round-trips through parse', () => {
  const result = parseArchive(anArchive());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.archive.games.length, 1);
  assert.equal(result.coreMatches, true);
});

test('anything that is not an archive is refused before it is read', () => {
  for (const junk of [null, undefined, 42, 'a string', [], { format: 'zip' }]) {
    const result = parseArchive(junk);
    assert.equal(result.ok, false, `${JSON.stringify(junk)} should not parse`);
    if (!result.ok) assert.equal(result.reason, 'notAnArchive');
  }
});

test('a future format version is refused rather than guessed at', () => {
  const result = parseArchive(anArchive({ version: ARCHIVE_VERSION + 1 }));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'unsupportedVersion');
});

/*
 * The trap the issue names by name. A state from a different core build does
 * not fail on load - it loads into garbage. So the mismatch is reported, and
 * the states are dropped; the SRAM is untouched by the core version and is
 * precisely why both kinds travel in one file.
 */
test('a state from a different core build is refused, and the SRAM still arrives', () => {
  const result = parseArchive(anArchive({ coreVersion: 'snes9x-0000000000000000000000000000000000000000' }));

  assert.equal(result.ok, true, 'refusing the whole file would throw away the battery saves too');
  if (!result.ok) return;
  assert.equal(result.coreMatches, false);
  assert.equal(result.archive.games[0].states.length, 0, 'the states are dropped, loudly');
  assert.equal(result.archive.games[0].sram, b64([1, 2, 3]), 'the SRAM has no core version');
});

/* -------------------------------------------------------------- the blobs */

test('a checksum that is not a CRC32 is refused', () => {
  for (const crc32 of ['', 'AABBCC', 'aabbccdd', 'ZZZZZZZZ', '../../etc', 12345678]) {
    const result = parseArchive(anArchive({ games: [aGame({ crc32: crc32 as string })] }));
    assert.equal(result.ok, false, `${crc32} should not parse`);
  }
});

test('a savestate that is not base64 is refused rather than silently truncated', () => {
  // Buffer.from(x, 'base64') drops anything it does not recognise instead of
  // throwing, so "valid base64" has to be checked before decoding, not after.
  const result = parseArchive(anArchive({ games: [aGame({ states: [{ ...aGame().states[0], data: 'not base64!!' }] })] }));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'malformed');
});

test('an oversized savestate is refused, so a claimed library cannot exhaust memory', () => {
  const huge = 'A'.repeat(Math.ceil((MAX_STATE_BYTES + 1024) / 3) * 4);
  const result = parseArchive(anArchive({ games: [aGame({ states: [{ ...aGame().states[0], data: huge }] })] }));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'tooLarge');
});

/*
 * A real savestate is over 800KB, so "valid" and "big" are the ordinary case
 * here, not an edge one. The first spelling of the base64 check used a
 * quantified group and threw `Maximum call stack size exceeded` on anything
 * this size - a validator that crashes on the ordinary case is a denial of
 * service, not a guard.
 */
test('a savestate of the size real ones are validates without blowing the stack', () => {
  const real = Buffer.alloc(900 * 1024, 7).toString('base64');
  const result = parseArchive(anArchive({ games: [aGame({ states: [{ ...aGame().states[0], data: real }] })] }));

  assert.equal(result.ok, true);
});

test('an oversized SRAM is refused', () => {
  const huge = 'A'.repeat(Math.ceil((MAX_SRAM_BYTES + 1024) / 3) * 4);
  const result = parseArchive(anArchive({ games: [aGame({ sram: huge })] }));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'tooLarge');
});

test('too many games, or too many states in one game, is refused', () => {
  const many = Array.from({ length: MAX_GAMES_PER_ARCHIVE + 1 }, () => aGame());
  assert.equal(parseArchive(anArchive({ games: many })).ok, false);

  const state = aGame().states[0];
  const manyStates = Array.from({ length: MAX_STATES_PER_GAME + 1 }, () => state);
  assert.equal(parseArchive(anArchive({ games: [aGame({ states: manyStates })] })).ok, false);
});

/*
 * The screenshot is the one field that reaches an `<img src>` unescaped. A
 * `javascript:` or an `http://` URL there would make an imported file a way to
 * point somebody else's browser wherever the author liked.
 */
test('a screenshot that is not an inline image data URL is refused', () => {
  const bad = [
    'javascript:alert(1)',
    'http://tracker.example/pixel.png',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4='
  ];
  for (const screenshot of bad) {
    const result = parseArchive(anArchive({ games: [aGame({ states: [{ ...aGame().states[0], screenshot }] })] }));
    assert.equal(result.ok, false, `${screenshot} should not parse`);
  }
});

test('a save with no screenshot is fine; a picture is optional', () => {
  const result = parseArchive(anArchive({ games: [aGame({ states: [{ ...aGame().states[0], screenshot: null }] })] }));

  assert.equal(result.ok, true);
});

test('a slot number that is not a positive integer is refused', () => {
  for (const slotNumber of [0, -1, 1.5, Number.NaN, '3', null]) {
    const result = parseArchive(
      anArchive({ games: [aGame({ states: [{ ...aGame().states[0], slotNumber: slotNumber as number }] })] })
    );
    assert.equal(result.ok, false, `slot ${slotNumber} should not parse`);
  }
});

test('a timestamp that is not a date is refused', () => {
  const result = parseArchive(
    anArchive({ games: [aGame({ states: [{ ...aGame().states[0], createdAt: 'yesterday' }] })] })
  );

  assert.equal(result.ok, false);
});

test('parsing never keeps a field the format does not define', () => {
  const result = parseArchive(
    anArchive({ games: [{ ...aGame(), userId: 'someone-else', id: 'row-1' } as unknown as ArchiveGame] })
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal('userId' in result.archive.games[0], false, 'the parser rebuilds, it does not pass through');
  assert.equal('id' in result.archive.games[0], false);
});
