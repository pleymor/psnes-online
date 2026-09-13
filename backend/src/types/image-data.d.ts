/**
 * `ImageData`, the pixel buffer the WASM codecs exchange.
 *
 * It is a DOM type, and this backend's `lib` is `["ES2022"]` on purpose -- no
 * DOM, so that nothing server-side can quietly reach for `document` or `fetch`'s
 * browser overloads and typecheck. Adding "dom" to satisfy one signature would
 * hand every file in backend/src the whole browser surface.
 *
 * So the one shape that actually crosses the boundary is declared here instead.
 * Structural, and type-only: nothing constructs an `ImageData` on this side, the
 * codecs return them and take them back.
 */
interface ImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: string;
}
