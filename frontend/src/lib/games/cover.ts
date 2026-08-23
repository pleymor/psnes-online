/**
 * A cover image, on its way from a file picker to the shared catalogue.
 *
 * The server keeps these as BLOBs beside the rest of a catalogue row and caps a
 * request at 400 KB, so the shrinking happens here rather than being rejected
 * there. The awkward part is inherited from save thumbnails:
 * `canvas.toDataURL('image/webp')` does NOT throw on a browser that cannot
 * encode WebP - it silently returns a PNG many times larger - so the format is
 * read back out of the result and JPEG is tried before giving up.
 */

import {
  imageFormatOf,
  scaledSize,
  type ImageFormat,
  type ThumbnailSize
} from '../saves/thumbnail.js';

/** Wide enough to read a box front, small enough to keep the row cheap. */
export const COVER_MAX_WIDTH = 512;

/** The same ceiling the server enforces; if these drift, the UI accepts what the API refuses. */
export const MAX_COVER_BYTES = 400 * 1024;

const QUALITY = 0.82;

const MIME: Record<ImageFormat, string> = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png'
};

export function coverSize(srcWidth: number, srcHeight: number): ThumbnailSize {
  return scaledSize(srcWidth, srcHeight, COVER_MAX_WIDTH);
}

/**
 * Reads a picked file and returns the bytes to send.
 *
 * Browser-only: it needs a real canvas. Throws when the file is not an image
 * the browser can decode, or when even the JPEG attempt stays above the cap - a
 * caller can do nothing useful with a picture the server will refuse.
 */
export async function encodeCover(file: File): Promise<{ bytes: Uint8Array; mime: string }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = coverSize(bitmap.width, bitmap.height);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot resize the image');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  for (const requested of ['image/webp', 'image/jpeg'] as const) {
    const uri = canvas.toDataURL(requested, QUALITY);
    const format = imageFormatOf(uri);
    if (!format) continue;
    const bytes = decodeDataUri(uri);
    // A PNG here means the browser ignored the request. It is accepted only if
    // it happens to fit, rather than looping forever on the same answer.
    if (bytes.byteLength <= MAX_COVER_BYTES) return { bytes, mime: MIME[format] };
  }

  throw new Error('That image is too large even once resized');
}

function decodeDataUri(uri: string): Uint8Array {
  const base64 = uri.slice(uri.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
