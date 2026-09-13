/**
 * What a cover is called, and where it is served from.
 *
 * A cover is named after its own source bytes, so replacing one produces a
 * different URL and `immutable` is the truth rather than a wish. The old
 * `/api/covers/<id>?v=<timestamp>` said the same thing by convention, but from
 * behind `requireAuth`, where no edge could act on it.
 */

import { createHash } from 'crypto';

/** Wide enough to read a box front. The width the browser already shrinks an upload to. */
export const COVER_WIDTH = 512;

/**
 * The identification list draws these at 40x30 CSS pixels and, until now,
 * downloaded the full 275 KB scan to do it. 160 covers a 2x display.
 */
export const THUMB_WIDTH = 160;

/** Where nginx serves the files from, with no session cookie in sight. */
export const COVERS_PATH = '/covers';

/**
 * Half a SHA-256, which is 64 bits of name.
 *
 * Enough that a collision across a few thousand covers is not a thing that
 * happens, and short enough to read in a log line next to a game title.
 */
export function coverHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function coverFileName(hash: string): string {
  return `${hash}.webp`;
}

export function thumbFileName(hash: string): string {
  return `${hash}-thumb.webp`;
}

export function coverUrlOf(hash: string): string {
  return `${COVERS_PATH}/${coverFileName(hash)}`;
}
