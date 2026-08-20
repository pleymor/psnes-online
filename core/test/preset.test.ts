/**
 * The .glslp interpreter.
 *
 * The subset is deliberately tiny - five directives - and the important
 * behaviour is not what it parses but what it REFUSES. `xbrz-freescale` was
 * dropped from the app's shader list because its viewport-relative scaling
 * gave WebGL framebuffer errors, which showed up as a black screen with no
 * message. Every refusal here names the directive that caused it.
 *
 * The presets below are the real files at the pinned commit
 * 468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7, copied verbatim so this suite
 * never touches the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePreset, resolveShaderUrl, presetUrl } from '../../frontend/src/lib/znet/preset.js';

const XBRZ_6X = `shaders = 2

shader0 = shaders/6xbrz.glsl
filter_linear0 = false
scale_type0 = source
scale0 = 6.0

shader1 = ../stock.glsl
filter_linear1 = true
`;

const CRT_EASYMODE = `shaders = 1

shader0 = shaders/crt-easymode.glsl
filter_linear0 = false
`;

const SHARP_BILINEAR = `shaders = 1

shader0 = shaders/sharp-bilinear-simple.glsl
filter_linear0 = true`;

const FXAA = `shaders = 1

shader0 = shaders/fxaa.glsl
filter_linear0 = true
scale_type0 = source
scale0 = 1.0
`;

function expectOk(source: string) {
  const result = parsePreset(source);
  assert.equal(result.ok, true, `expected the preset to parse, got: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error('unreachable');
  return result.preset;
}

test('the two-pass xBRZ preset is understood, both passes in order', () => {
  const preset = expectOk(XBRZ_6X);

  assert.equal(preset.passes.length, 2);
  assert.equal(preset.passes[0].shaderPath, 'shaders/6xbrz.glsl');
  assert.equal(preset.passes[0].filterLinear, false);
  assert.equal(preset.passes[0].scale, 6);
  assert.equal(preset.passes[1].shaderPath, '../stock.glsl');
  assert.equal(preset.passes[1].filterLinear, true);
  assert.equal(preset.passes[1].scale, null, 'the last pass draws to the canvas, so it has no scale');
});

test('a single-pass preset with no scale directive is understood', () => {
  const preset = expectOk(CRT_EASYMODE);

  assert.equal(preset.passes.length, 1);
  assert.equal(preset.passes[0].shaderPath, 'shaders/crt-easymode.glsl');
  assert.equal(preset.passes[0].filterLinear, false);
  assert.equal(preset.passes[0].scale, null);
});

test('a preset whose last line has no trailing newline still parses', () => {
  // sharp-bilinear-simple.glslp genuinely ends without one.
  const preset = expectOk(SHARP_BILINEAR);

  assert.equal(preset.passes.length, 1);
  assert.equal(preset.passes[0].filterLinear, true);
});

test('scale 1.0 is kept as 1, not treated as absent', () => {
  const preset = expectOk(FXAA);

  assert.equal(preset.passes[0].scale, 1, 'an explicit 1.0 is not the same as no directive');
});

test('a viewport scale_type is refused and named - this is the xbrz-freescale case', () => {
  const result = parsePreset('shaders = 1\nshader0 = a.glsl\nscale_type0 = viewport\nscale0 = 1.0\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.directive, /scale_type0/);
  assert.match(result.reason, /viewport/);
});

test('an absolute scale_type is refused too, since only source is supported', () => {
  const result = parsePreset('shaders = 1\nshader0 = a.glsl\nscale_type0 = absolute\nscale0 = 512\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.directive, /scale_type0/);
});

test('an unknown directive is refused by its own name, not by a generic message', () => {
  const result = parsePreset('shaders = 1\nshader0 = a.glsl\nwrap_mode0 = repeat\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.directive, 'wrap_mode0', 'the caller must be able to say WHICH directive');
});

test('frame history is refused, since the renderer keeps no previous frames', () => {
  const result = parsePreset('shaders = 1\nshader0 = a.glsl\nframe_count_mod0 = 2\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.directive, 'frame_count_mod0');
});

test('a pass count that does not match the shaderN lines present is refused', () => {
  const result = parsePreset('shaders = 3\nshader0 = a.glsl\nshader1 = b.glsl\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.directive, /shader2/, 'name the pass that is missing');
});

test('an empty preset is refused rather than producing a zero-pass pipeline', () => {
  const result = parsePreset('');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.directive, /shaders/);
});

test('a preset with no shaders directive at all is refused', () => {
  const result = parsePreset('shader0 = a.glsl\nfilter_linear0 = true\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.directive, /shaders/);
});

test('a zero pass count is refused', () => {
  const result = parsePreset('shaders = 0\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.directive, 'shaders');
});

test('comments and blank lines are ignored', () => {
  const preset = expectOk('# a comment\nshaders = 1\n\n// another\nshader0 = a.glsl\n');

  assert.equal(preset.passes.length, 1);
});

test('quoted values are unquoted, as RetroArch writes them that way', () => {
  const preset = expectOk('shaders = "1"\nshader0 = "shaders/a.glsl"\n');

  assert.equal(preset.passes[0].shaderPath, 'shaders/a.glsl');
});

test('filter_linear accepts the spellings RetroArch actually writes', () => {
  assert.equal(expectOk('shaders = 1\nshader0 = a.glsl\nfilter_linear0 = "true"\n').passes[0].filterLinear, true);
  assert.equal(expectOk('shaders = 1\nshader0 = a.glsl\nfilter_linear0 = 1\n').passes[0].filterLinear, true);
  assert.equal(expectOk('shaders = 1\nshader0 = a.glsl\nfilter_linear0 = false\n').passes[0].filterLinear, false);
  assert.equal(expectOk('shaders = 1\nshader0 = a.glsl\nfilter_linear0 = 0\n').passes[0].filterLinear, false);
});

test('a filter_linear that is neither true nor false is refused rather than guessed', () => {
  const result = parsePreset('shaders = 1\nshader0 = a.glsl\nfilter_linear0 = maybe\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.directive, /filter_linear0/);
});

test('a non-numeric scale is refused rather than becoming NaN', () => {
  const result = parsePreset('shaders = 1\nshader0 = a.glsl\nscale_type0 = source\nscale0 = big\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.directive, /scale0/);
});

test('a hypothetical "shaders2" key is refused by its own name, not accepted as base "shaders"', () => {
  // SUPPORTED_DIRECTIVES used to be one list doing two jobs: the literal
  // 'shaders' and the indexed prefixes both lived in it, so splitIndexed's
  // regex match on 'shaders2' -> base 'shaders' would have passed the
  // includes() check. This is the case that hole would have let through.
  const result = parsePreset('shaders = 1\nshader0 = a.glsl\nshaders2 = 1\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.directive, 'shaders2');
});

test('a line with no "=" is refused rather than half-read - the CDN error-page case', () => {
  // A captive portal or a CDN outage can serve an HTML error page with a 200
  // status. The first line of that page has no '=', and the whole preset must
  // be refused rather than silently skipping the malformed line and reading
  // whatever happens to parse after it.
  const result = parsePreset('<!DOCTYPE html>\nshaders = 1\nshader0 = a.glsl\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.directive, '<!DOCTYPE html>');
  assert.match(result.reason, /not a key = value line/);
});

test('a directive belonging to a pass beyond the declared count is refused', () => {
  // Otherwise a preset could smuggle in a pass the pipeline never allocates.
  const result = parsePreset('shaders = 1\nshader0 = a.glsl\nfilter_linear1 = true\n');

  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  assert.match(result.directive, /filter_linear1/);
});

test('a relative shader path resolves against the preset directory', () => {
  const base = 'https://cdn.example/gh/libretro/glsl-shaders@abc/xbrz/6xbrz-linear.glslp';

  assert.equal(
    resolveShaderUrl(base, 'shaders/6xbrz.glsl'),
    'https://cdn.example/gh/libretro/glsl-shaders@abc/xbrz/shaders/6xbrz.glsl'
  );
});

test('a ../ shader path climbs out of the preset directory - the stock.glsl case', () => {
  const base = 'https://cdn.example/gh/libretro/glsl-shaders@abc/xbrz/6xbrz-linear.glslp';

  assert.equal(
    resolveShaderUrl(base, '../stock.glsl'),
    'https://cdn.example/gh/libretro/glsl-shaders@abc/stock.glsl'
  );
});

test('presetUrl builds the pinned .glslp URL for a shader id', () => {
  assert.equal(
    presetUrl('xbrz/6xbrz-linear'),
    'https://cdn.jsdelivr.net/gh/libretro/glsl-shaders@468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7/xbrz/6xbrz-linear.glslp'
  );
});
