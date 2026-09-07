/**
 * The filter that stops the picture boiling, in one three-free module.
 *
 * `screen.ts` used `NearestFilter` both ways, with a comment saying smoothing
 * the picture "is the opposite of what anyone came for". That was right about
 * smoothing and wrong about the consequence. The numbers: 256 texels across a
 * 60 degree arc is 4.3 texels per degree against roughly 20 pixels per degree
 * in the headset, so one SNES texel covers about five display pixels. Nearest
 * snaps all five to the same texel, so a fraction of a degree of head movement
 * sweeps the boundary across a pixel and flips a whole column at once. Every
 * column doing that at once is what reads as the screen being liquid.
 *
 * The third option is neither: sample exactly at texel centres, as nearest
 * does, EXCEPT within one display pixel of a texel boundary, where the
 * coordinate slides through so the hardware's own bilinear tap straddles the
 * seam. The pixels stay square and hard - only their edges gain sub-pixel
 * coverage, and that is what removes the snapping. A bilinear picture would be
 * a blurred mess; this is not that.
 *
 * `filteredTexel` is the specification and the GLSL below is a transliteration
 * of it. The pairing is deliberate: there is no GPU under Bun, so writing the
 * arithmetic where it can actually be run is the only way to hold it to
 * account. Change one and change the other.
 */

import { visibleU } from './screen-geometry';

/**
 * Where to sample, in texel space, for a screen pixel landing at `t`.
 *
 * `footprint` is how many texels one display pixel covers - `fwidth` in the
 * shader. `visible` is where the picture stops, in texels, which is NOT the
 * texture's width: see `pictureUniforms`.
 *
 * Three properties, all of them tested:
 *
 * - Away from a boundary the answer is a texel centre, so this is still
 *   nearest-neighbour for the vast majority of pixels.
 * - Within half a display pixel of a boundary it slides, which is one blended
 *   pixel per edge and no more.
 * - It never leaves `[0.5, visible - 0.5]`. That half-texel inset is the
 *   important one: past `visible` is the padded half of every row, and a
 *   bilinear tap at the picture's right edge would blend it in. Nearest never
 *   could, because its samples sat at pixel centres strictly inside.
 *
 * The divisor is clamped at BOTH ends, and each end fixes a bug this module's
 * tests caught:
 *
 * - Capped at one texel, because a footprint above that means the picture is
 *   minified and there is no sub-texel detail left to preserve. Dividing by
 *   the real footprint there pulls the coordinate toward the seam - toward MORE
 *   blending, not less - whereas a divisor of exactly 1 makes the clamp a
 *   no-op and passes the coordinate straight through as plain bilinear, which
 *   is the right answer. (The screen never recedes, so this is a guard rather
 *   than a case that happens.)
 * - Floored at an epsilon rather than special-cased, because `fwidth` is zero
 *   wherever the derivative vanishes. Substituting a zero OFFSET there lands
 *   on the seam - the 50/50 blend, the blurriest possible answer - while a
 *   tiny divisor saturates the clamp and lands on the texel centre, which is
 *   nearest, which is what this used to be.
 */
export function filteredTexel(t: number, footprint: number, visible: number): number {
  const seam = Math.floor(t + 0.5);
  const divisor = Math.min(Math.max(footprint, 1e-6), 1);
  const offset = Math.min(Math.max((t - seam) / divisor, -0.5), 0.5);
  return Math.min(Math.max(seam + offset, 0.5), visible - 0.5);
}

export interface PictureUniforms {
  /** The PADDED texture, which is what the sampler indexes. */
  texSize: [number, number];
  /** Where the picture stops, as a fraction of the texture's width. */
  uMax: number;
}

/**
 * What the shader needs to know about the current picture's shape.
 *
 * The two fields are easy to confuse and expensive to confuse: `texSize` is
 * `stride` wide because that is the texture the sampler indexes, while the
 * picture ends at `uMax` of it. Passing the picture's width as the texture
 * size would put the seams in the wrong places; treating the texture as all
 * picture would show the padding.
 */
export function pictureUniforms(
  width: number,
  height: number,
  stride: number
): PictureUniforms {
  return { texSize: [stride, height], uMax: visibleU(width, stride) };
}

/** Nothing but the uv. The screen is unlit, like everything else in here. */
export const PICTURE_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/*
 * A transliteration of `filteredTexel`, twice - once per axis.
 *
 * Written in three's GLSL1 dialect on purpose: `WebGLProgram.js:805` compiles
 * every shader as `#version 300 es` and supplies the compatibility defines, so
 * `texture2D` and `gl_FragColor` are the ones three's own chunks use, and
 * `fwidth` is core rather than an extension.
 *
 * The two includes at the end are the whole reason this is a `ShaderMaterial`
 * and not a `RawShaderMaterial` (`WebGLProgram.js:801` only prefixes the
 * former). `colorspace_fragment` is not optional: the texture is uploaded as
 * `SRGB8_ALPHA8` (`WebGLTextures.js:234`), so the GPU hands the sample back in
 * linear light and it has to be encoded again on the way out - exactly what
 * `meshbasic.glsl.js:110` does. Omitting it does not fail, it just shifts every
 * colour, which is the kind of regression nobody notices until the screenshots
 * are compared. `tonemapping_fragment` is deliberately absent, which is what
 * the old material's `toneMapped: false` said: the SNES palette IS the
 * picture, and tone mapping would crush it toward grey.
 */
export const PICTURE_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D map;
uniform vec2 texSize;
uniform float uMax;

varying vec2 vUv;

void main() {
  // Texel space of the padded texture.
  vec2 t = vUv * texSize;

  // The nearest texel boundary, and how many texels one display pixel covers.
  vec2 seam = floor(t + 0.5);
  vec2 footprint = fwidth(t);

  // Snap to the texel centre, except within half a display pixel of the seam.
  // The divisor is clamped at both ends for the reasons filteredTexel spells
  // out: capped at one texel so a minified picture passes through as plain
  // bilinear, floored at an epsilon so a vanished derivative saturates to the
  // texel centre - nearest - instead of landing on the seam.
  vec2 divisor = clamp(footprint, vec2(1e-6), vec2(1.0));
  t = seam + clamp((t - seam) / divisor, -0.5, 0.5);

  // Half a texel inside the picture, never into the padded half of the row.
  vec2 visible = vec2(uMax * texSize.x, texSize.y);
  t = clamp(t, vec2(0.5), visible - 0.5);

  gl_FragColor = texture2D(map, t / texSize);

  #include <colorspace_fragment>
}
`;
