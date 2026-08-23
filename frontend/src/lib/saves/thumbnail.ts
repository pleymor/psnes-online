/**
 * A small picture of the moment a save was taken.
 *
 * It is stored as a data URI in the Save row's `screenshot` column, alongside
 * a savestate of about 823KB, so it has to be small enough to disappear next
 * to that - a couple of kilobytes, not tens.
 *
 * The awkward part is that `canvas.toDataURL('image/webp')` does **not** throw
 * on a browser that cannot encode WebP. It silently returns a PNG, which at
 * these dimensions is roughly ten times larger. So the format is read back out
 * of the URI and the caller falls through to JPEG rather than accepting that
 * silently.
 */

/** Wide enough to recognise a scene, small enough to be free. */
export const THUMBNAIL_WIDTH = 128;

/** Quality low enough to be tiny; a thumbnail does not need to be faithful. */
const QUALITY = 0.6;

export type ImageFormat = 'webp' | 'jpeg' | 'png';

export interface ThumbnailSize {
  width: number;
  height: number;
}

/**
 * The size to draw at: the target width, keeping the source's shape.
 *
 * A source already narrower than the target is left alone - upscaling a
 * thumbnail buys nothing and costs bytes. A degenerate source (a capture taken
 * before the first frame was drawn) still yields at least one pixel, because a
 * zero-sized canvas throws.
 */
export function scaledSize(srcWidth: number, srcHeight: number, maxWidth: number): ThumbnailSize {
  const width = Math.max(1, Math.min(maxWidth, Math.round(srcWidth) || 1));
  const ratio = srcWidth > 0 ? width / srcWidth : 1;
  const height = Math.max(1, Math.round((srcHeight || 1) * ratio));
  return { width, height };
}

export function thumbnailSize(srcWidth: number, srcHeight: number): ThumbnailSize {
  return scaledSize(srcWidth, srcHeight, THUMBNAIL_WIDTH);
}

/**
 * The format a data URI actually carries, as opposed to the one requested.
 *
 * Returns null for anything unrecognised rather than guessing, so a caller
 * cannot mistake "no idea" for "the format I wanted".
 */
export function imageFormatOf(dataUri: string): ImageFormat | null {
  const match = /^data:image\/(webp|jpeg|png)[;,]/.exec(dataUri);
  return match ? (match[1] as ImageFormat) : null;
}

/**
 * Captures the canvas as a small data URI, or null if it cannot.
 *
 * Tries WebP, then JPEG, and accepts whatever the browser produced last -
 * a PNG thumbnail is bigger than we would like but still far better than no
 * picture at all. Browser-only: it needs a real canvas.
 */
export function captureThumbnail(source: HTMLCanvasElement): string | null {
  const { width, height } = thumbnailSize(source.width, source.height);

  try {
    const scaled = document.createElement('canvas');
    scaled.width = width;
    scaled.height = height;

    const ctx = scaled.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, width, height);

    for (const format of ['webp', 'jpeg'] as const) {
      const uri = scaled.toDataURL(`image/${format}`, QUALITY);
      if (imageFormatOf(uri) === format) return uri;
    }

    // Both were declined, so whatever came back is a PNG. Take it.
    return scaled.toDataURL('image/png');
  } catch {
    // A tainted canvas, or no 2d context. A save without a picture is fine.
    return null;
  }
}
