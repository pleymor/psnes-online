/**
 * The zero-copy video accessor.
 *
 * `videoFrame()` repacks the core's fixed-stride buffer into a tight array so
 * it can go into an ImageData. The stride is 512 (PN_MAX_WIDTH) whatever the
 * visible width is, so for the usual 256-wide SNES output that repack copies
 * and throws away half of every row, every frame.
 *
 * WebGL does not need it - UNPACK_ROW_LENGTH lets GL read the sub-rectangle
 * straight out of wasm memory. This checks the view describes the right bytes.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { PsnesCore } from '../../frontend/src/lib/znet/core.js';
import type { PsnesCoreModule } from '../../frontend/src/lib/znet/core.js';

const VIDEO_BASE = 1024;

/**
 * A module with just enough surface for the video accessors.
 *
 * Each pixel is stamped with its row so a caller can prove which bytes it got:
 * row y is filled with the byte value y + 1.
 */
function fakeModule(width: number, height: number, stride: number): PsnesCoreModule {
  const heap = new Uint8Array(VIDEO_BASE + stride * height * 4);
  for (let y = 0; y < height; y++) {
    heap.fill(y + 1, VIDEO_BASE + y * stride * 4, VIDEO_BASE + (y * stride + width) * 4);
  }

  return {
    HEAPU8: heap,
    _pn_init: () => 1,
    _pn_video: () => VIDEO_BASE,
    _pn_video_width: () => width,
    _pn_video_height: () => height,
    _pn_video_stride: () => stride
  } as unknown as PsnesCoreModule;
}

async function coreWith(width: number, height: number, stride: number): Promise<PsnesCore> {
  return PsnesCore.create(async () => fakeModule(width, height, stride));
}

test('the surface reports the core stride, not the visible width', async () => {
  const core = await coreWith(256, 224, 512);

  const surface = core.videoSurface();

  assert.equal(surface.width, 256);
  assert.equal(surface.height, 224);
  assert.equal(surface.stride, 512, 'the renderer needs the real row length to set UNPACK_ROW_LENGTH');
});

test('the view is long enough to cover every row at full stride', async () => {
  const core = await coreWith(256, 224, 512);

  const surface = core.videoSurface();

  // GL reads (height - 1) full rows plus `width` pixels of the last one. A
  // view any shorter makes texImage2D read out of bounds.
  assert.ok(
    surface.data.length >= ((224 - 1) * 512 + 256) * 4,
    `view of ${surface.data.length} bytes cannot cover the sub-rectangle`
  );
});

test('the view starts at the core buffer, so row 0 is the first row', async () => {
  const core = await coreWith(256, 224, 512);

  const surface = core.videoSurface();

  assert.equal(surface.data[0], 1, 'row 0 is stamped with 1');
});

test('a row is found at stride*4 bytes, which is what proves it is not repacked', async () => {
  const core = await coreWith(256, 224, 512);

  const surface = core.videoSurface();

  assert.equal(surface.data[512 * 4], 2, 'row 1 sits one full stride in, not one width in');
  assert.equal(surface.data[256 * 4], 0, 'the gap past the visible width is untouched padding');
});

test('a high-resolution frame is described without reallocating anything', async () => {
  const core = await coreWith(512, 448, 512);

  const surface = core.videoSurface();

  assert.equal(surface.width, 512);
  assert.equal(surface.height, 448);
  assert.equal(surface.stride, 512, 'at full width, stride and width coincide');
});

test('videoFrame still repacks tightly, so the 2D path is unaffected', async () => {
  const core = await coreWith(256, 224, 512);

  const frame = core.videoFrame();

  assert.equal(frame.data.length, 256 * 224 * 4, 'the 2D path still gets a tight buffer');
  assert.equal(frame.data[256 * 4], 2, 'and row 1 still starts one WIDTH in, not one stride');
});
