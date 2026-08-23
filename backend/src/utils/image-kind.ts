/**
 * The format a file actually is, read from its own first bytes.
 *
 * A declared Content-Type is a claim made by the uploader, and these bytes come
 * back out of the server with a Content-Type we set - so believing the claim
 * would let one player choose the type another player's browser applies to the
 * response.
 */

export type ImageKind = 'image/png' | 'image/jpeg' | 'image/webp';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function imageKindOf(bytes: Buffer): ImageKind | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // WebP is a RIFF container, so both markers have to be checked: the first
  // four bytes alone would also accept a WAV file.
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
