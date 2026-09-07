/**
 * The filter that stops the picture boiling.
 *
 * `NearestFilter` is what made the curved screen look liquid, and the numbers
 * say why: 256 texels across a 60 degree arc is 4.3 texels per degree against
 * roughly 20 pixels per degree in the headset, so one SNES texel covers about
 * five display pixels. Nearest snaps every one of those five to the same
 * texel, so when the head turns a fraction of a degree the boundary sweeps
 * across a pixel and a whole column flips at once. Multiply by every column on
 * screen and the picture crawls.
 *
 * Smoothing it is not the answer - `screen.ts` was right about that, and a
 * bilinear 256-wide picture on a two-metre screen is a blurred mess. This
 * filter is the third option: sample exactly at texel centres, as nearest
 * does, EXCEPT within one display pixel of a texel boundary, where the
 * coordinate is allowed to slide through so the hardware's own bilinear tap
 * straddles the seam. Pixels stay square and hard; only their edges get
 * sub-pixel coverage, which is what removes the snapping.
 *
 * This module is the specification and `screen.ts`'s GLSL is a transliteration
 * of it. That pairing is deliberate - there is no GPU under Bun, so the only
 * way to hold this arithmetic to account is to write it where it can be run.
 */

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  filteredTexel,
  pictureUniforms,
  PICTURE_FRAGMENT_SHADER
} from '../../frontend/src/lib/vr/picture-filter.js';

/** A 256-wide picture magnified about fivefold, which is the real case. */
const FOOTPRINT = 0.2;
const VISIBLE = 256;

test('away from a boundary the sample sits exactly on a texel centre', () => {
  // Texel 10 spans t = 10..11 and its centre is 10.5. Anything comfortably
  // inside it must land there, or this is not nearest-neighbour any more.
  for (const t of [10.15, 10.3, 10.5, 10.7, 10.85]) {
    assert.equal(filteredTexel(t, FOOTPRINT, VISIBLE), 10.5, `t=${t} drifted off the centre`);
  }
});

test('on the boundary itself the tap straddles the two texels evenly', () => {
  // t = 11 is the 50/50 point between texel 10 and texel 11. That single
  // blended pixel IS the antialiasing.
  assert.equal(filteredTexel(11, FOOTPRINT, VISIBLE), 11);
});

test('the blend is one display pixel wide and no more', () => {
  const half = FOOTPRINT / 2;
  // Half a display pixel either side of the seam is already fully snapped.
  // Compared with a tolerance: `11 - 0.1` is not exactly 10.9 in binary, and
  // the clamp lands a few ulps short of saturating.
  assert.ok(Math.abs(filteredTexel(11 - half, FOOTPRINT, VISIBLE) - 10.5) < 1e-9);
  assert.ok(Math.abs(filteredTexel(11 + half, FOOTPRINT, VISIBLE) - 11.5) < 1e-9);
  // And inside that pixel it moves smoothly rather than jumping.
  assert.ok(filteredTexel(11 - half / 2, FOOTPRINT, VISIBLE) > 10.5);
  assert.ok(filteredTexel(11 - half / 2, FOOTPRINT, VISIBLE) < 11);
});

test('the sample never reaches the padded half of a row', () => {
  /*
   * This is the trap the whole file exists to close. The texture is `stride`
   * wide - 512 for a 256-wide picture - and everything past `width` is memory
   * nobody should see (`screen-geometry.ts` explains why it is uploaded at
   * all). Nearest never showed it because its sample points sat at pixel
   * centres, strictly inside. A bilinear tap at the picture's right edge does
   * NOT: at t = 256 it would blend texel 255 with texel 256, which is padding,
   * and `showTestPattern()` fills that magenta on purpose so the failure is
   * unmistakable.
   */
  assert.equal(filteredTexel(256, FOOTPRINT, VISIBLE), 255.5);
  assert.equal(filteredTexel(300, FOOTPRINT, VISIBLE), 255.5);
  assert.ok(filteredTexel(255.9, FOOTPRINT, VISIBLE) <= 255.5);
});

test('nor the far side of texel zero', () => {
  assert.equal(filteredTexel(0, FOOTPRINT, VISIBLE), 0.5);
  assert.equal(filteredTexel(-5, FOOTPRINT, VISIBLE), 0.5);
});

test('a minified picture degenerates to plain bilinear rather than misbehaving', () => {
  // One texel per display pixel or worse: there is no sub-texel detail left to
  // preserve, and snapping would alias. Passing the coordinate through
  // untouched is exactly the right answer, and it falls out of the arithmetic.
  assert.equal(filteredTexel(10.3, 1, VISIBLE), 10.3);
  assert.ok(Math.abs(filteredTexel(10.3, 4, VISIBLE) - 10.3) < 1e-9);
});

test('a footprint of zero behaves as nearest instead of dividing by it', () => {
  // `fwidth` is zero wherever the derivative vanishes. A NaN here would be a
  // black or garbage screen, so it degrades to the old behaviour.
  assert.equal(filteredTexel(10.3, 0, VISIBLE), 10.5);
});

test('the mapping never runs backwards', () => {
  // A non-monotonic filter would mirror a sliver of the picture, which reads
  // as corruption rather than as blur.
  let previous = -Infinity;
  for (let t = 0; t <= VISIBLE; t += 0.017) {
    const sampled = filteredTexel(t, FOOTPRINT, VISIBLE);
    assert.ok(sampled >= previous - 1e-9, `t=${t} went backwards`);
    previous = sampled;
  }
});

/*
 * The uniforms, where the stride lives.
 *
 * `texSize` is the PADDED texture, because that is what the sampler indexes,
 * while the visible limit is `uMax` of it. Getting these two confused would
 * either show the padding or squeeze the picture into half the screen, and
 * both have happened on this branch before.
 */
test('the uniforms describe the padded texture and where the picture stops', () => {
  assert.deepEqual(pictureUniforms(256, 224, 512), { texSize: [512, 224], uMax: 0.5 });
});

test('an unpadded picture is simply uMax 1', () => {
  assert.deepEqual(pictureUniforms(512, 448, 512), { texSize: [512, 448], uMax: 1 });
});

test('a degenerate shape samples everything rather than nothing', () => {
  // `visibleU`'s rule, and for its reason: showing the padding at least looks
  // like padding, while a zero would make the screen one column of pixels.
  assert.equal(pictureUniforms(0, 224, 512).uMax, 1);
  assert.equal(pictureUniforms(256, 224, 0).uMax, 1);
});

/*
 * The GLSL is not executable here, so what is checked is that it still carries
 * the pieces this module's tests are about. It is a smoke alarm for a careless
 * edit - somebody deleting the edge clamp would otherwise ship the magenta
 * fringe with every test still green.
 */
test('the shader still contains the parts these tests speak for', () => {
  for (const piece of ['fwidth', 'clamp', 'uMax', 'texSize', 'colorspace_fragment']) {
    assert.ok(PICTURE_FRAGMENT_SHADER.includes(piece), `the shader lost ${piece}`);
  }
  assert.ok(
    !PICTURE_FRAGMENT_SHADER.includes('tonemapping_fragment'),
    'the SNES palette is the picture; tone mapping would crush it toward grey'
  );
});
