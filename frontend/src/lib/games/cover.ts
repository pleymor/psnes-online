/**
 * A cover image, on its way from a file picker to the shared catalogue.
 *
 * The server keeps these as BLOBs beside the rest of a catalogue row and caps a
 * request at 400 KB, so the shrinking happens here rather than being rejected
 * there.
 *
 * The awkward part is inherited from save thumbnails: asking a canvas for WebP
 * does NOT throw on a browser that cannot encode it - it silently hands back a
 * PNG many times larger. `toBlob` makes that visible without a detour, because
 * the blob reports the type it actually is; `toDataURL` would mean decoding
 * base64 by hand to get the same answer, at a third more memory.
 */

import { scaledSize, type ThumbnailSize } from '../saves/thumbnail.js';

/** Wide enough to read a box front, small enough to keep the row cheap. */
export const COVER_MAX_WIDTH = 512;

/** The same ceiling the server enforces; if these drift, the UI accepts what the API refuses. */
export const MAX_COVER_BYTES = 400 * 1024;

const QUALITY = 0.82;

/** The three the server will store. Anything else is refused there on its header bytes. */
const ACCEPTED = ['image/webp', 'image/jpeg', 'image/png'] as const;

/** The formats to ask for, best first. PNG is not requested - it is what a refusal looks like. */
const REQUESTED = ['image/webp', 'image/jpeg'] as const;

export function coverSize(srcWidth: number, srcHeight: number): ThumbnailSize {
  return scaledSize(srcWidth, srcHeight, COVER_MAX_WIDTH);
}

/**
 * The type a blob actually carries, if the server would take it.
 *
 * Returns null for anything else rather than guessing, so a caller cannot
 * mistake "no idea" for "the format I asked for".
 */
export function coverMimeOf(blobType: string): string | null {
  const type = blobType.split(';')[0].trim().toLowerCase();
  return (ACCEPTED as readonly string[]).includes(type) ? type : null;
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, QUALITY));
}

/**
 * Reads a picked file and returns the body to send.
 *
 * Browser-only: it needs a real canvas. Throws when the file is not an image
 * the browser can decode, or when even the JPEG attempt stays above the cap - a
 * caller can do nothing useful with a picture the server will refuse.
 */
export async function encodeCover(file: File): Promise<{ blob: Blob; mime: string }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = coverSize(bitmap.width, bitmap.height);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot resize the image');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  for (const requested of REQUESTED) {
    const blob = await toBlob(canvas, requested);
    if (!blob) continue;
    const mime = coverMimeOf(blob.type);
    // A PNG here means the browser ignored the request. It is taken only if it
    // happens to fit, rather than looping forever on the same answer.
    if (mime && blob.size <= MAX_COVER_BYTES) return { blob, mime };
  }

  throw new Error('That image is too large even once resized');
}
