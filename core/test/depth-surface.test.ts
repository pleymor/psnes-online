/**
 * The per-pixel layer plane.
 *
 * `pn_depth()` hands back one byte per pixel saying which of the SNES's planes
 * won it, which is what lets the VR renderer push a background further away
 * than the sprites in front of it. It shares the video buffer's 512-pixel
 * stride but not its pixel size: one byte here against four there. Read it
 * with the video buffer's row arithmetic and every row lands three quarters
 * of a line out, so these tests pin the stride down in bytes.
 *
 * The plane also carries the BG mode and the BG3 priority bit, because the
 * byte on its own does not name a layer - see frontend/src/lib/vr/layer-map.ts.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { PsnesCore } from '../../frontend/src/lib/znet/core.js';
import type { PsnesCoreModule } from '../../frontend/src/lib/znet/core.js';

const VIDEO_BASE = 1024;

/** The depth plane is laid out after the video buffer, as it is in the core. */
function depthBase(height: number, stride: number): number {
  return VIDEO_BASE + stride * height * 4;
}

/**
 * A module with just enough surface for the depth accessor.
 *
 * Each row is stamped with its own index (row y holds y + 1) across the
 * visible width only, which is what the core does: it writes x < width and
 * leaves the padding as it found it.
 */
function fakeModule(
  width: number,
  height: number,
  stride: number,
  mode = 1,
  bg3Priority = 0
): PsnesCoreModule {
  const base = depthBase(height, stride);
  const heap = new Uint8Array(base + stride * height);
  for (let y = 0; y < height; y++) {
    heap.fill(y + 1, base + y * stride, base + y * stride + width);
  }

  return {
    HEAPU8: heap,
    _pn_init: () => 1,
    _pn_video: () => VIDEO_BASE,
    _pn_video_width: () => width,
    _pn_video_height: () => height,
    _pn_video_stride: () => stride,
    _pn_depth: () => base,
    _pn_depth_bg_mode: () => mode,
    _pn_depth_bg3_prio: () => bg3Priority
  } as unknown as PsnesCoreModule;
}

async function coreWith(width: number, height: number, stride: number): Promise<PsnesCore> {
  return PsnesCore.create(async () => fakeModule(width, height, stride));
}

test('the plane reports the core stride, not the visible width', async () => {
  const core = await coreWith(256, 224, 512);

  const surface = core.depthSurface();

  assert.equal(surface.width, 256);
  assert.equal(surface.height, 224);
  assert.equal(surface.stride, 512, 'the picture is the left 256 of a 512-wide buffer');
});

test('the view is one byte per pixel, so it is a quarter of the video buffer', async () => {
  const core = await coreWith(256, 224, 512);

  const surface = core.depthSurface();

  assert.equal(surface.data.length, 512 * 224);
  assert.ok(
    surface.data.length >= (224 - 1) * 512 + 256,
    'a shorter view cannot reach the last pixel of the last row'
  );
});

test('a row sits one byte-stride in, which is what proves the pixel size', async () => {
  const core = await coreWith(256, 224, 512);

  const surface = core.depthSurface();

  assert.equal(surface.data[0], 1, 'row 0 is stamped with 1');
  assert.equal(surface.data[512], 2, 'row 1 begins 512 bytes in, not 512 pixels of RGBA');
  assert.equal(surface.data[512 * 4], 5, 'the video row stride would land four rows down');
});

test('the padding past the visible width is reachable but is not picture', async () => {
  const core = await coreWith(256, 224, 512);

  const surface = core.depthSurface();

  assert.equal(surface.data[255], 1, 'the last pixel of row 0 is stamped');
  assert.equal(surface.data[256], 0, 'the core only writes x < width, so the rest stays blank');
  assert.ok(surface.data.length > 256 * 224, 'the padding is inside the view, not cropped out');
});

test('the plane is a view into the heap, not a snapshot of it', async () => {
  const core = await coreWith(256, 224, 512);
  const base = depthBase(224, 512);

  const surface = core.depthSurface();
  core.raw.HEAPU8[base + 5] = 42;

  assert.equal(surface.data[5], 42, 'a copy taken at call time would still read the stamp');
});

test('each call re-reads the heap, because growth detaches the old view', async () => {
  const core = await coreWith(256, 224, 512);
  const base = depthBase(224, 512);

  const before = core.depthSurface();

  // What emscripten does when the heap grows: the module's typed arrays are
  // replaced wholesale over a new buffer. A view held across that keeps
  // pointing at memory nobody writes to any more, and the layers would freeze
  // on whatever frame was showing when the allocation happened.
  const grown = new Uint8Array(core.raw.HEAPU8.length);
  grown[base] = 99;
  core.raw.HEAPU8 = grown;

  const after = core.depthSurface();

  assert.equal(before.data[0], 1, 'the stale view still sees the abandoned buffer');
  assert.equal(after.data[0], 99, 'the fresh one sees the current heap');
});

test('the BG mode travels with the plane, since the byte alone does not name a layer', async () => {
  const core = await PsnesCore.create(async () => fakeModule(256, 224, 512, 7, 0));

  assert.equal(core.depthSurface().mode, 7, 'mode 7 puts BG1 where no other mode does');
});

test('BG3 priority arrives as a boolean, which is the shape slotTable asks for', async () => {
  const on = await PsnesCore.create(async () => fakeModule(256, 224, 512, 1, 1));
  const off = await PsnesCore.create(async () => fakeModule(256, 224, 512, 1, 0));

  assert.equal(on.depthSurface().bg3Priority, true);
  assert.equal(off.depthSurface().bg3Priority, false);
});

test('a high-resolution frame is described without reallocating anything', async () => {
  const core = await coreWith(512, 448, 512);

  const surface = core.depthSurface();

  assert.equal(surface.width, 512);
  assert.equal(surface.height, 448);
  assert.equal(surface.data.length, 512 * 448, 'at full width there is no padding left');
});
