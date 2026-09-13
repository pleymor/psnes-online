/**
 * The covers directory: a volume nginx serves straight from.
 *
 * Everything in it is derived. The catalogue's source of truth is the remote
 * URL in snes-metadata.json and an upload's is the BLOB in prod.db, so this
 * directory can be deleted and rebuilt, and is not worth backing up.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { coverFileName, thumbFileName, coverUrlOf } from './naming.js';
// Type-only, so the codecs are not pulled in just to write a file.
import type { Rendition } from './render.js';

/** Beside `avatars`, and mounted the same way. */
export const COVERS_DIR = path.join(process.cwd(), 'covers');

/**
 * A name is sixteen hex characters, and nothing else ever becomes a path.
 *
 * The hash reaches here from the ingestion rather than from a request, but a
 * traversal at this point writes anywhere the process can reach, and the check
 * costs one regex.
 */
function fileFor(dir: string, name: string, hash: string): string {
  if (!/^[0-9a-f]{16}$/.test(hash)) throw new Error(`not a cover name: ${JSON.stringify(hash)}`);
  return path.join(dir, name);
}

/** True only when both renditions are there - a pass killed between the two writes must be redone. */
export async function hasCover(dir: string, hash: string): Promise<boolean> {
  try {
    await Promise.all([
      fs.access(fileFor(dir, coverFileName(hash), hash)),
      fs.access(fileFor(dir, thumbFileName(hash), hash))
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Writes both renditions and returns the URL the metadata row will carry. */
export async function storeRendition(dir: string, rendition: Rendition): Promise<string> {
  const cover = fileFor(dir, coverFileName(rendition.hash), rendition.hash);
  const thumb = fileFor(dir, thumbFileName(rendition.hash), rendition.hash);

  await fs.mkdir(dir, { recursive: true });
  // The display rendition last: `hasCover` asks for both, so a pass killed
  // between the two writes leaves the cover incomplete and it is redone.
  await fs.writeFile(thumb, rendition.thumb);
  await fs.writeFile(cover, rendition.cover);

  return coverUrlOf(rendition.hash);
}
