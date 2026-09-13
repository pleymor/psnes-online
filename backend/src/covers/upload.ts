/**
 * A cover a player uploads, on its way to the volume nginx serves.
 *
 * The browser has already shrunk it to 512 px and encoded it as WebP
 * (frontend/src/lib/games/cover.ts), and the route has already read its format
 * out of its own header bytes. What is left to do here is write it where an
 * edge can reach it, and make the small rendition the identification list
 * needs.
 */

import type { Database } from '../db/sqlite.js';
import { setCover, setServedCover } from '../db/game-metadata.js';
import { renderCover } from './render.js';
import { storeRendition, COVERS_DIR } from './store.js';
import { createLogger } from '../utils/logger.js';
import type { ImageKind } from '../utils/image-kind.js';

const logger = createLogger('Covers');

/**
 * Stores an uploaded cover and returns the URL to serve it from.
 *
 * The BLOB is written first and unconditionally: it is the one image here that
 * cannot be fetched again from anywhere, and the files on the volume are
 * derived from it. If the bytes then fail to decode - a truncated file whose
 * header was still valid - the upload is kept and served the old way rather
 * than lost, and the next warming pass names it.
 */
export async function acceptUploadedCover(
  db: Database,
  metadataId: string,
  bytes: Buffer,
  mime: ImageKind,
  dir: string = COVERS_DIR
): Promise<string> {
  const legacyUrl = setCover(db, metadataId, bytes, mime);

  try {
    const url = await storeRendition(dir, await renderCover(bytes, mime));
    setServedCover(db, metadataId, url);
    return url;
  } catch (error) {
    logger.warn(
      { err: error, metadataId },
      'An uploaded cover did not decode; keeping it, served from the database'
    );
    return legacyUrl;
  }
}
