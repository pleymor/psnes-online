/**
 * The file a player's progress travels in.
 *
 * This is portability, not backup - the server's own safety net is an
 * off-box copy and has nothing to do with this module. What this answers is
 * the player who changes machine, or who wants a copy of a hundred hours in
 * their own hands.
 *
 * Two decisions shape everything below.
 *
 * **The envelope is a list.** One game and a whole library are the same file
 * format, a single game being a list of one, so the two things a player
 * actually wants - "move me to my new laptop" and "here, take my finished
 * file" - never need two formats or two parsers.
 *
 * **A game is a CRC32.** `Game` rows are per-player (`Game_userId_crc32_key`),
 * so a file naming a row id would only ever work for the account it came from.
 * The checksum is what the frontend already computes from the player's own
 * file (`roms/checksum.ts`), and it is what an import matches on.
 *
 * Everything else here is the parser, and the parser is a whitelist: it
 * rebuilds each object field by field rather than passing an incoming one
 * through. An import is the one endpoint where somebody hands us blobs that
 * end up in a row keyed by an account, so "looks about right" is not a
 * standard it can be held to.
 */

export const ARCHIVE_FORMAT = 'psnes-saves';
export const ARCHIVE_VERSION = 1;

/**
 * The snes9x build whose state format these savestates are.
 *
 * `pn_state_save` emits the state of the exact commit `core/build.sh` pins, and
 * a state from another build does not fail on load - it loads into garbage.
 * Silent corruption of someone's progress is the one outcome a feature about
 * safekeeping cannot have, so the file carries the build's name and an import
 * refuses a mismatch out loud.
 *
 * Kept as a literal rather than read from `core/build.sh`, which is not in the
 * backend image; `backend/test/saves-archive.test.ts` reads the real file and
 * fails if the two ever drift.
 */
export const CORE_STATE_VERSION = 'snes9x-97c65a34a2eb8592de6c7b44a0ad681895684a41';

/*
 * The ceilings.
 *
 * A savestate is a little over 800KB today and SNES battery SRAM tops out at
 * 128KB on real hardware, so these leave generous room while still bounding
 * what one request can allocate. They are checked on the *decoded* length -
 * checking the base64 string would leave a third of the budget on the table
 * and make the numbers meaningless.
 */
export const MAX_STATE_BYTES = 4 * 1024 * 1024;
export const MAX_SRAM_BYTES = 512 * 1024;
export const MAX_SCREENSHOT_CHARS = 512 * 1024;
export const MAX_STATES_PER_GAME = 100;
export const MAX_GAMES_PER_ARCHIVE = 200;
export const MAX_NAME_CHARS = 200;
/** The request body cap. Two hundred games of screenshots is the shape of it. */
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

export interface ArchiveState {
  name: string;
  slotNumber: number;
  /** base64 of the snes9x state named by `coreVersion`. */
  data: string;
  /** A `data:image/...` URL, or null. */
  screenshot: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveGame {
  crc32: string;
  title: string;
  filename: string;
  /** base64 of the cartridge's battery SRAM, or null. */
  sram: string | null;
  sramUpdatedAt: string | null;
  states: ArchiveState[];
}

export interface SaveArchive {
  format: typeof ARCHIVE_FORMAT;
  version: number;
  coreVersion: string;
  exportedAt: string;
  games: ArchiveGame[];
}

/* ---------------------------------------------------------------- building */

/** What the database hands the builder: one game, both kinds of save. */
export interface ExportableGame {
  crc32: string;
  title: string;
  filename: string;
  sram: Buffer | null;
  sramUpdatedAt: Date | null;
  saves: {
    name: string;
    slotNumber: number;
    data: Buffer;
    screenshot: string | null;
    createdAt: Date;
    updatedAt: Date;
  }[];
}

export interface BuildOptions {
  /**
   * Whether thumbnails travel. They do by default - a wall of save tiles with
   * no pictures is much harder to recognise than a wall with them, and the
   * pictures are the only thing distinguishing two saves taken the same
   * evening. But `Save.screenshot` is a PNG data URL, so a full library is
   * mostly screenshot by weight, and a player on a slow line deserves the
   * choice rather than a 200MB download.
   */
  screenshots?: boolean;
  now?: Date;
}

export function buildArchive(games: ExportableGame[], options: BuildOptions = {}): SaveArchive {
  const screenshots = options.screenshots !== false;
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    coreVersion: CORE_STATE_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    games: games.map(game => ({
      crc32: game.crc32,
      title: game.title,
      filename: game.filename,
      sram: game.sram ? game.sram.toString('base64') : null,
      sramUpdatedAt: game.sramUpdatedAt ? game.sramUpdatedAt.toISOString() : null,
      states: game.saves.map(save => ({
        name: save.name,
        slotNumber: save.slotNumber,
        data: save.data.toString('base64'),
        screenshot: screenshots ? save.screenshot : null,
        createdAt: save.createdAt.toISOString(),
        updatedAt: save.updatedAt.toISOString()
      }))
    }))
  };
}

/* ----------------------------------------------------------------- parsing */

/** Why a file was not accepted. One reason per remedy, not per line of code. */
export type ArchiveProblem =
  | 'notAnArchive'
  | 'unsupportedVersion'
  | 'malformed'
  | 'tooLarge';

export type ParseResult =
  | {
      ok: true;
      archive: SaveArchive;
      /**
       * False when the file was written by a different core build. The states
       * have already been dropped from `archive` in that case - the caller
       * reports it, it does not have to enforce it.
       */
      coreMatches: boolean;
    }
  | { ok: false; reason: ArchiveProblem; detail: string };

const CRC32 = /^[0-9A-F]{8}$/;

/**
 * Base64, checked without a quantified group.
 *
 * The obvious spelling - `/^(?:[A-Za-z0-9+\/]{4})*.../` - throws
 * `RangeError: Maximum call stack size exceeded` on a multi-megabyte string,
 * because V8 recurses once per repetition of a grouped quantifier. A savestate
 * is 800KB of base64 and the whole point of this module is that the input is
 * hostile, so a validator that crashes on a large one is a denial of service
 * dressed as a guard. A flat character class stars linearly and does not.
 */
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_BODY.test(value);
}

/**
 * The screenshot is the only field that reaches an `<img src>` as written. So
 * it is not "a string that starts with data:" but a raster image, inline, in
 * base64. SVG is excluded on purpose despite being an image type: it carries
 * script, and an imported file must not become a way to run code in the
 * browser of whoever it was handed to.
 */
const IMAGE_DATA_URL_PREFIX = /^data:image\/(png|jpeg|webp);base64,/;

function isImageDataUrl(value: string): boolean {
  const prefix = IMAGE_DATA_URL_PREFIX.exec(value);
  if (!prefix) return false;
  return isBase64(value.slice(prefix[0].length));
}

function fail(reason: ArchiveProblem, detail: string): ParseResult {
  return { ok: false, reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The decoded byte length of a base64 string, without decoding it. */
function decodedLength(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

/** The longest base64 string that can hold `bytes`, so a cap can be applied
 *  to the encoded string before anything walks it. */
function encodedCap(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return value;
}

/**
 * Rebuilds an archive from an untrusted value, or says why it will not.
 *
 * Rebuilds rather than validates in place: the returned objects are
 * constructed here field by field, so an incoming `userId`, `id` or `__proto__`
 * cannot ride along into a caller that later spreads the object into a query.
 */
export function parseArchive(input: unknown): ParseResult {
  if (!isRecord(input)) return fail('notAnArchive', 'not an object');
  if (input.format !== ARCHIVE_FORMAT) return fail('notAnArchive', 'wrong format marker');
  if (typeof input.version !== 'number' || !Number.isInteger(input.version)) {
    return fail('notAnArchive', 'no version');
  }
  if (input.version > ARCHIVE_VERSION) {
    return fail('unsupportedVersion', `version ${input.version} was written by a newer release`);
  }
  if (typeof input.coreVersion !== 'string') return fail('malformed', 'no core version');
  if (!Array.isArray(input.games)) return fail('malformed', 'games is not a list');
  if (input.games.length > MAX_GAMES_PER_ARCHIVE) {
    return fail('tooLarge', `${input.games.length} games, the ceiling is ${MAX_GAMES_PER_ARCHIVE}`);
  }

  const coreMatches = input.coreVersion === CORE_STATE_VERSION;

  const games: ArchiveGame[] = [];
  for (const raw of input.games) {
    const game = parseGame(raw, coreMatches);
    if ('reason' in game) return fail(game.reason, game.detail);
    games.push(game.game);
  }

  return {
    ok: true,
    coreMatches,
    archive: {
      format: ARCHIVE_FORMAT,
      version: input.version,
      coreVersion: input.coreVersion,
      exportedAt: isTimestamp(input.exportedAt) ? input.exportedAt : new Date(0).toISOString(),
      games
    }
  };
}

type GameResult = { game: ArchiveGame } | { reason: ArchiveProblem; detail: string };

function parseGame(raw: unknown, coreMatches: boolean): GameResult {
  if (!isRecord(raw)) return { reason: 'malformed', detail: 'a game is not an object' };

  const crc32 = typeof raw.crc32 === 'string' && CRC32.test(raw.crc32) ? raw.crc32 : null;
  if (!crc32) return { reason: 'malformed', detail: 'a game has no usable CRC32' };

  const title = text(raw.title, MAX_NAME_CHARS);
  if (!title) return { reason: 'malformed', detail: `${crc32} has no title` };
  const filename = text(raw.filename, MAX_NAME_CHARS);
  if (!filename) return { reason: 'malformed', detail: `${crc32} has no filename` };

  let sram: string | null = null;
  if (raw.sram !== null && raw.sram !== undefined) {
    if (typeof raw.sram !== 'string') {
      return { reason: 'malformed', detail: `${crc32}: SRAM is not a string` };
    }
    // The cap comes first, on the encoded string: nothing should walk a
    // hostile blob before its size is known to be finite.
    if (raw.sram.length > encodedCap(MAX_SRAM_BYTES)) {
      return { reason: 'tooLarge', detail: `${crc32}: SRAM over ${MAX_SRAM_BYTES} bytes` };
    }
    if (!isBase64(raw.sram)) {
      return { reason: 'malformed', detail: `${crc32}: SRAM is not base64` };
    }
    if (decodedLength(raw.sram) > MAX_SRAM_BYTES) {
      return { reason: 'tooLarge', detail: `${crc32}: SRAM over ${MAX_SRAM_BYTES} bytes` };
    }
    sram = raw.sram;
  }

  if (!Array.isArray(raw.states)) return { reason: 'malformed', detail: `${crc32}: states is not a list` };
  if (raw.states.length > MAX_STATES_PER_GAME) {
    return { reason: 'tooLarge', detail: `${crc32}: ${raw.states.length} savestates` };
  }

  const states: ArchiveState[] = [];
  for (const rawState of raw.states) {
    const state = parseState(rawState, crc32);
    if ('reason' in state) return state;
    // Dropped here rather than at the call site: a state from another build
    // loads into garbage, so it must not survive parsing at all. The SRAM
    // beside it is unaffected, which is why both kinds share one file.
    if (coreMatches) states.push(state.state);
  }

  return {
    game: {
      crc32,
      title,
      filename,
      sram,
      sramUpdatedAt: isTimestamp(raw.sramUpdatedAt) ? raw.sramUpdatedAt : null,
      states
    }
  };
}

type StateResult = { state: ArchiveState } | { reason: ArchiveProblem; detail: string };

function parseState(raw: unknown, crc32: string): StateResult {
  if (!isRecord(raw)) return { reason: 'malformed', detail: `${crc32}: a savestate is not an object` };

  const name = text(raw.name, MAX_NAME_CHARS);
  if (name === null) return { reason: 'malformed', detail: `${crc32}: a savestate has no name` };

  if (typeof raw.slotNumber !== 'number' || !Number.isInteger(raw.slotNumber) || raw.slotNumber < 1) {
    return { reason: 'malformed', detail: `${crc32}: slot number is not a positive integer` };
  }

  // Buffer.from(x, 'base64') discards anything it does not recognise rather
  // than throwing, so a corrupt state would decode to a shorter, plausible
  // buffer and be written as somebody's progress. Checked before decoding.
  if (typeof raw.data !== 'string' || raw.data.length === 0) {
    return { reason: 'malformed', detail: `${crc32}: savestate is missing` };
  }
  if (raw.data.length > encodedCap(MAX_STATE_BYTES)) {
    return { reason: 'tooLarge', detail: `${crc32}: savestate over ${MAX_STATE_BYTES} bytes` };
  }
  if (!isBase64(raw.data)) {
    return { reason: 'malformed', detail: `${crc32}: savestate is not base64` };
  }
  if (decodedLength(raw.data) > MAX_STATE_BYTES) {
    return { reason: 'tooLarge', detail: `${crc32}: savestate over ${MAX_STATE_BYTES} bytes` };
  }

  let screenshot: string | null = null;
  if (raw.screenshot !== null && raw.screenshot !== undefined) {
    if (typeof raw.screenshot !== 'string' || raw.screenshot.length > MAX_SCREENSHOT_CHARS) {
      return { reason: 'tooLarge', detail: `${crc32}: screenshot too large` };
    }
    if (!isImageDataUrl(raw.screenshot)) {
      return { reason: 'malformed', detail: `${crc32}: screenshot is not an inline image` };
    }
    screenshot = raw.screenshot;
  }

  if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.updatedAt)) {
    return { reason: 'malformed', detail: `${crc32}: a savestate has no usable timestamps` };
  }

  return {
    state: {
      name,
      slotNumber: raw.slotNumber,
      data: raw.data,
      screenshot,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt
    }
  };
}
