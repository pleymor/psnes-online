/**
 * The two renditions we serve, made from whatever a cover host returned.
 *
 * WASM codecs rather than libvips, on purpose. Measured on 2026-09-13 against
 * the real Donkey Kong Country 2 scan: sharp is ~3x faster and 6% smaller, and
 * costs +72 MB of runtime image -- against a Dockerfile that explains at length
 * why the native dependencies were taken out. The whole catalogue converts in
 * about 70 seconds of encoding, once, and an upload in about 50 ms. The
 * warming pass itself is network-bound and far slower than that -- see
 * db/covers-cli.ts -- but none of that waiting is the codec's.
 */

import { decode as decodePng } from '@jsquash/png';
import { decode as decodeJpeg } from '@jsquash/jpeg';
import { decode as decodeWebpImage, encode as encodeWebp } from '@jsquash/webp';
import resizeImage from '@jsquash/resize';
import { coverHash, COVER_WIDTH, THUMB_WIDTH } from './naming.js';
import type { ImageKind } from '../utils/image-kind.js';

/**
 * 75 rather than the 82 the browser uses for an upload.
 *
 * The browser is encoding one picture a player chose and is looking at; this is
 * encoding 1415 scans nobody has asked for yet, and the difference between the
 * two settings was measured at 46.2 KB against 55.4 KB a cover -- 13 MB across
 * the catalogue for a difference no one can see at 512 px.
 */
const QUALITY = 75;

export interface Rendition {
  /** Named after the SOURCE bytes, so a codec bump does not rename everything. */
  hash: string;
  cover: Buffer;
  thumb: Buffer;
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function decode(bytes: Buffer, mime: ImageKind): Promise<ImageData> {
  const source = toArrayBuffer(bytes);
  if (mime === 'image/png') return decodePng(source);
  if (mime === 'image/jpeg') return decodeJpeg(source);
  return decodeWebpImage(source);
}

/**
 * Narrower than the target is left alone: upscaling invents detail and costs
 * bytes, and some catalogue scans really are small.
 */
async function at(image: ImageData, width: number): Promise<Buffer> {
  const scaled =
    image.width <= width
      ? image
      : await resizeImage(image, {
          width,
          height: Math.round((image.height / image.width) * width)
        });
  return Buffer.from(await encodeWebp(scaled, { quality: QUALITY }));
}

/** Throws when the bytes do not decode - a broken source must not become a written file. */
export async function renderCover(bytes: Buffer, mime: ImageKind): Promise<Rendition> {
  const image = await decode(bytes, mime);
  return {
    hash: coverHash(bytes),
    cover: await at(image, COVER_WIDTH),
    thumb: await at(image, THUMB_WIDTH)
  };
}
