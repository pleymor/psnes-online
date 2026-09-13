/**
 * Reading what a cover URL actually returned.
 *
 * The Content-Type is useless here. raw.githubusercontent serves a git symlink
 * under `image/png` while the body is the target's *name* in plain text, so the
 * bytes are the only witness worth believing -- the same reasoning as
 * `utils/image-kind.ts`, one step earlier in the pipe.
 */

import { imageKindOf, type ImageKind } from '../utils/image-kind.js';

export type CoverBody =
  | { kind: 'image'; mime: ImageKind; bytes: Buffer }
  | { kind: 'symlink'; url: string }
  | { kind: 'unusable' };

/**
 * A git symlink body is a bare path, and in Named_Boxarts always a sibling.
 * Long enough for the longest real boxart name, short enough that no HTML page
 * fits through.
 */
const MAX_SYMLINK_BYTES = 255;

/** Fetched bytes, decided on their own content. `url` is what was fetched. */
export function readCoverBody(url: string, bytes: Buffer): CoverBody {
  const mime = imageKindOf(bytes);
  if (mime) return { kind: 'image', mime, bytes };

  if (bytes.length === 0 || bytes.length > MAX_SYMLINK_BYTES) return { kind: 'unusable' };

  const target = bytes.toString('utf8').trim();
  if (!isSiblingName(target)) return { kind: 'unusable' };

  const directory = url.slice(0, url.lastIndexOf('/') + 1);
  return { kind: 'symlink', url: directory + encodeURIComponent(target) };
}

/**
 * A name in the same directory, and nothing else.
 *
 * These bytes come from a third party and are about to become a URL the server
 * fetches, so anything with a slash, a control character, or a leading dot is
 * refused rather than normalised into something that looks safe.
 */
function isSiblingName(target: string): boolean {
  if (target.length === 0 || target.length > MAX_SYMLINK_BYTES) return false;
  if (target.includes('/') || target.includes('\\')) return false;
  if (target.startsWith('.')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(target)) return false;
  return /\.(png|jpe?g|webp)$/i.test(target);
}
