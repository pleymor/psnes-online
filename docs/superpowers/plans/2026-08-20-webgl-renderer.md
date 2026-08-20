# WebGL2 Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the lockstep (`znet`) stack a WebGL2 renderer that runs the same libretro GLSL shaders the RetroArch path already runs, behind `CanvasRenderer`'s existing interface, falling back to 2D whenever anything is missing or unsupported.

**Architecture:** Three new files with one job each — a pure `.glslp` interpreter (no DOM, no network, fully unit-tested), a fetcher that turns a shader id into resolved sources, and a `WebglRenderer` exposing the exact constructor/`setOptions`/`draw` surface `LockstepRoom` already uses. The renderer is a passive sink: it never owns a timer and never influences when a frame runs. Selection happens in `LockstepRoom`, which tries WebGL and silently keeps the 2D renderer on any failure.

**Tech Stack:** TypeScript, SvelteKit 4 (Svelte 4 reactivity rules apply), WebGL2, libretro `glsl-shaders` at pinned commit `468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7`, `node --import tsx --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-20-webgl-renderer-design.md` — read it before Task 1. The plan argues from it; where they disagree, the spec wins.

## Global Constraints

These bind every task. They are copied from the spec verbatim where the spec states a value.

- **The renderer never drives timing.** No `requestAnimationFrame`, no `setTimeout`, no `setInterval`, no vsync coupling, no frame skipping, no "draw when ready" anywhere in `webgl-renderer.ts` or `preset.ts`. `FrameGovernor` is the only timer owner in this stack. A renderer that influenced pacing would make two players' emulation depend on their GPUs.
- **The supported `.glslp` subset is exactly five directives:** `shaders`, `shaderN`, `filter_linearN`, `scale_typeN` (value `source` only), `scaleN`. Everything else is refused **by name**. No wrap modes, no frame history, no aliases, no float framebuffers, no mipmaps, no viewport-relative scaling.
- **Never define `PARAMETER_UNIFORM`.** `crt-easymode.glsl` declares 17 parameters as uniforms under `#ifdef PARAMETER_UNIFORM` and their defaults as `#define` in the `#else` branch. Defining it without supplying all 17 uniforms leaves them at zero — a black picture with no compilation error.
- **Never emit a `#version` directive.** These shaders target GLSL ES 1.00 and branch on `__VERSION__ >= 130`. With no `#version`, `__VERSION__` is 100 and they compile as ES 1.00, which is the path they were written for. WebGL2 accepts this.
- **Shader paths inside a preset are relative to the preset URL** (`shader0 = shaders/6xbrz.glsl`, `shader1 = ../stock.glsl`). Resolve them as relative URLs. Do not reuse `resolveShader`'s hardcoded special-case table from `frontend/src/lib/emulator/libs/options.ts`.
- **Pinned shader source:** `https://cdn.jsdelivr.net/gh/libretro/glsl-shaders@468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7`. Same repo, same commit as the RetroArch path, so both paths show identical output.
- **Fall back to 2D, never to a black screen.** Four cases: no WebGL2 context, a preset outside the subset, a compile/link failure, and `webglcontextlost` mid-game.
- **Shader choice is local and cosmetic.** It never crosses the network and is never part of the lockstep protocol. Two players may differ.
- **A new test file must be added to the `test:ui` script** in the root `package.json`. That script lists files explicitly; a test file that is not listed never runs.
- **Tabs, not spaces**, in `frontend/src/lib/znet/*.ts` — match the surrounding files.
- **No new runtime dependencies.** Issues #10/#11 cut the dependency surface deliberately; this feature adds none.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `frontend/src/lib/znet/preset.ts` | Pure `.glslp` parsing and path resolution. No DOM, no `fetch`. Returns a discriminated union: understood, or refused with the offending directive named. |
| `frontend/src/lib/znet/shader-source.ts` | Turns a shader id into a fetched, resolved `LoadedPreset`. Owns all networking. |
| `frontend/src/lib/znet/webgl-renderer.ts` | The GL pipeline: program compilation, per-pass framebuffers, frame upload, resolution reallocation, context-loss handling. |
| `core/test/preset.test.ts` | Unit tests for `preset.ts` — the only part of this feature that is testable in Node. |

**Modified:**

| File | Change |
|---|---|
| `frontend/src/lib/znet/core.ts` | Add `videoSurface()`, a zero-copy view into wasm memory. `videoFrame()` is untouched. |
| `frontend/src/lib/znet/output.ts` | Add `shader: string` to `DisplayOptions` and `DEFAULT_DISPLAY`; extract the shared `Renderer` interface. |
| `frontend/src/lib/znet/index.ts` | Export the new symbols. |
| `frontend/src/lib/components/LockstepRoom.svelte` | Declare both canvases, pick a renderer, read the stored shader preference, add the toolbar control. |
| `package.json` | Add the new test files to `test:ui`. |

**Task order and why:** `preset.ts` first because it is pure and fully tested, and its types are what every later task consumes. Then `core.ts`'s upload path (independent, testable by reasoning about a fake module). Then the GL renderer, which needs both. Then the wiring, which needs all three. Networking (`shader-source.ts`) lands with the renderer that uses it.

---

## Task 1: The `.glslp` interpreter

**Files:**
- Create: `frontend/src/lib/znet/preset.ts`
- Create: `core/test/preset.test.ts`
- Modify: `package.json` (the `test:ui` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `const SUPPORTED_DIRECTIVES: readonly string[]`
  - `interface PresetPass { shaderPath: string; filterLinear: boolean; scale: number | null }`
  - `interface Preset { passes: PresetPass[] }`
  - `type PresetResult = { ok: true; preset: Preset } | { ok: false; directive: string; reason: string }`
  - `function parsePreset(source: string): PresetResult`
  - `function resolveShaderUrl(presetUrl: string, shaderPath: string): string`

### Why a discriminated union rather than an exception

The spec's rule is that anything outside the subset is refused **and named**. A thrown error can be swallowed by a `try` that was written for something else; a returned union cannot be ignored without TypeScript noticing. `xbrz-freescale` was removed from the app's shader list because its viewport-relative scaling produced WebGL framebuffer errors — a black screen with no explanation. A named refusal is the fix for that class of failure.

- [ ] **Step 1: Write the failing tests**

Create `core/test/preset.test.ts`. The four real presets are inlined verbatim rather than fetched, so the suite never depends on the network.

```ts
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
import { parsePreset, resolveShaderUrl } from '../../frontend/src/lib/znet/preset.js';

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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/preset.test.ts
```

Expected: every test fails with a module-resolution error — `Cannot find module '.../frontend/src/lib/znet/preset.js'`. That is the correct first failure; do not proceed until you have seen it.

- [ ] **Step 3: Write the interpreter**

Create `frontend/src/lib/znet/preset.ts`. Tabs for indentation, to match the rest of `znet/`.

```ts
/**
 * A restricted reader for libretro's `.glslp` preset format.
 *
 * The app offers six shaders, and between them they use exactly five
 * directives. This reads those five and refuses everything else BY NAME.
 *
 * That refusal is the point of the module, not a safety afterthought.
 * `xbrz-freescale` was dropped from the app's shader list because its
 * viewport-relative scaling produced WebGL framebuffer errors - which the
 * player experienced as a black screen with no message. Naming the directive
 * we cannot honour turns that into a fallback plus an explanation.
 *
 * Pure by design: no DOM, no fetch, no globals. Everything here is decided
 * from a string, which is what makes it the only unit-testable part of the
 * WebGL path.
 */

/** The whole supported vocabulary. `shaderN` and friends match by prefix. */
export const SUPPORTED_DIRECTIVES: readonly string[] = [
	'shaders',
	'shader',
	'filter_linear',
	'scale_type',
	'scale'
];

export interface PresetPass {
	/** As written in the preset - relative to the preset's own URL. */
	shaderPath: string;
	/** GL_LINEAR when true, GL_NEAREST when false. Absent directive means false. */
	filterLinear: boolean;
	/**
	 * Multiplier on the input size for this pass's render target, or null when
	 * the preset gives none. The final pass ignores it: it draws to the canvas.
	 */
	scale: number | null;
}

export interface Preset {
	passes: PresetPass[];
}

export type PresetResult =
	| { ok: true; preset: Preset }
	| { ok: false; directive: string; reason: string };

/** Splits `filter_linear0` into `['filter_linear', 0]`; null when there is no index. */
function splitIndexed(key: string): { base: string; index: number } | null {
	const match = /^([a-z_]+?)(\d+)$/.exec(key);
	if (!match) return null;
	return { base: match[1], index: Number(match[2]) };
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** RetroArch writes booleans as true/false and as 1/0; both appear in the wild. */
function readBool(value: string): boolean | null {
	if (value === 'true' || value === '1') return true;
	if (value === 'false' || value === '0') return false;
	return null;
}

function refuse(directive: string, reason: string): PresetResult {
	return { ok: false, directive, reason };
}

export function parsePreset(source: string): PresetResult {
	const entries = new Map<string, string>();

	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#') || line.startsWith('//')) continue;

		const eq = line.indexOf('=');
		if (eq === -1) {
			return refuse(line, 'not a key = value line');
		}
		entries.set(line.slice(0, eq).trim(), unquote(line.slice(eq + 1)));
	}

	const shadersRaw = entries.get('shaders');
	if (shadersRaw === undefined) {
		return refuse('shaders', 'the preset declares no pass count');
	}
	const passCount = Number(shadersRaw);
	if (!Number.isInteger(passCount) || passCount < 1) {
		return refuse('shaders', `pass count must be a positive integer, got "${shadersRaw}"`);
	}

	// Reject unknown or out-of-range directives before reading anything, so a
	// preset can never be half-honoured.
	for (const key of entries.keys()) {
		if (key === 'shaders') continue;

		const indexed = splitIndexed(key);
		if (!indexed || !SUPPORTED_DIRECTIVES.includes(indexed.base)) {
			return refuse(key, 'directive is outside the supported subset');
		}
		if (indexed.index >= passCount) {
			return refuse(key, `refers to pass ${indexed.index}, but the preset declares ${passCount}`);
		}
	}

	const passes: PresetPass[] = [];

	for (let i = 0; i < passCount; i++) {
		const shaderPath = entries.get(`shader${i}`);
		if (shaderPath === undefined || shaderPath === '') {
			return refuse(`shader${i}`, `pass ${i} has no shader file`);
		}

		let filterLinear = false;
		const filterRaw = entries.get(`filter_linear${i}`);
		if (filterRaw !== undefined) {
			const parsed = readBool(filterRaw);
			if (parsed === null) {
				return refuse(`filter_linear${i}`, `expected true or false, got "${filterRaw}"`);
			}
			filterLinear = parsed;
		}

		const scaleTypeRaw = entries.get(`scale_type${i}`);
		if (scaleTypeRaw !== undefined && scaleTypeRaw !== 'source') {
			return refuse(
				`scale_type${i}`,
				`only "source" is supported, got "${scaleTypeRaw}" - viewport and absolute scaling need a framebuffer policy this renderer does not have`
			);
		}

		let scale: number | null = null;
		const scaleRaw = entries.get(`scale${i}`);
		if (scaleRaw !== undefined) {
			const parsed = Number(scaleRaw);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				return refuse(`scale${i}`, `expected a positive number, got "${scaleRaw}"`);
			}
			scale = parsed;
		}

		passes.push({ shaderPath, filterLinear, scale });
	}

	return { ok: true, preset: { passes } };
}

/**
 * Resolves a preset's shader path against the preset's own URL.
 *
 * Presets name their files relatively - `shaders/6xbrz.glsl`, and
 * `../stock.glsl` for a second pass that lives one level up. Plain URL
 * resolution handles both, which is why this needs no table of special cases.
 */
export function resolveShaderUrl(presetUrl: string, shaderPath: string): string {
	return new URL(shaderPath, presetUrl).toString();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/preset.test.ts
```

Expected: PASS, 20 tests.

- [ ] **Step 5: Register the test file so it actually runs in CI**

In `package.json`, append `core/test/preset.test.ts` to the `test:ui` script. That script lists its files explicitly, so a test file that is not listed is silently never run.

```json
"test:ui": "node --import tsx --test core/test/capture-gate.test.ts core/test/input.test.ts core/test/rom-provider.test.ts core/test/room-snapshot.test.ts core/test/thumbnail.test.ts core/test/saves-api.test.ts core/test/preset.test.ts",
```

- [ ] **Step 6: Verify the registration is real, by breaking it on purpose**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:ui 2>&1 | grep -c "preset"
```

Expected: a non-zero count, proving the new file is in the run. If it is zero, the script edit did not take.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/znet/preset.ts core/test/preset.test.ts package.json
git commit -m "Read the .glslp subset the app actually uses, refuse the rest by name"
```

---

## Task 2: A zero-copy view of the video buffer

**Files:**
- Modify: `frontend/src/lib/znet/core.ts` (add `videoSurface()` after `videoFrame()`, around line 164)
- Modify: `frontend/src/lib/znet/index.ts` (export the new type)
- Test: `core/test/preset.test.ts` is unrelated; this task adds tests to a new file `core/test/video-surface.test.ts`
- Modify: `package.json` (register the new test file)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `interface VideoSurface { data: Uint8Array; width: number; height: number; stride: number }`
  - `PsnesCore.prototype.videoSurface(): VideoSurface`

### Why this exists

`videoFrame()` repacks the core's fixed-stride buffer row by row into a tight `width * height` array, because `putImageData` needs one. `core/src/psnes_core.c:470` returns `PN_MAX_WIDTH` — 512 — unconditionally, while the visible width is usually 256, so that repack copies and discards half the buffer every frame. WebGL does not need it: `UNPACK_ROW_LENGTH` tells GL the source row length and it reads the sub-rectangle itself.

`videoFrame()` is left exactly as it is. The 2D path keeps working unchanged, and this is purely additive.

- [ ] **Step 1: Write the failing test**

Create `core/test/video-surface.test.ts`. It uses a hand-built fake module rather than the real wasm core, because the property under test is arithmetic on offsets — no emulation needed.

```ts
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

import test from 'node:test';
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/video-surface.test.ts
```

Expected: FAIL with `core.videoSurface is not a function` on the first five tests. The sixth (`videoFrame still repacks`) should already PASS — it describes existing behaviour, and its job is to catch a regression in Step 3.

- [ ] **Step 3: Add the accessor**

In `frontend/src/lib/znet/core.ts`, add the interface next to `VideoFrame` (after line 57):

```ts
/**
 * A live view of the core's video buffer, with no copy.
 *
 * `data` points into wasm memory and is only valid until the next core call -
 * anything that can grow the heap invalidates it. Upload it and forget it.
 * `stride` is the buffer's row length in pixels and is always >= width, so a
 * consumer must skip the padding itself (in WebGL, via UNPACK_ROW_LENGTH).
 */
export interface VideoSurface {
	data: Uint8Array;
	width: number;
	height: number;
	stride: number;
}
```

And the method immediately after `videoFrame()` (after line 164):

```ts
	/**
	 * The same frame as `videoFrame()`, without the repack.
	 *
	 * The core's stride is fixed at PN_MAX_WIDTH (512) whatever the visible
	 * width is, so `videoFrame`'s row-by-row copy discards half of every row
	 * at the usual 256-wide output. WebGL can read the sub-rectangle directly,
	 * so it takes this instead. The 2D path still needs the tight buffer.
	 */
	videoSurface(): VideoSurface {
		const width = this.module._pn_video_width();
		const height = this.module._pn_video_height();
		const stride = this.module._pn_video_stride();
		const base = this.module._pn_video();
		// A fresh subarray each call: the previous one may have been detached by
		// a heap growth, and a stale view is a silent read of the wrong memory.
		const data = this.module.HEAPU8.subarray(base, base + stride * height * 4);
		return { data, width, height, stride };
	}
```

- [ ] **Step 4: Export the type**

In `frontend/src/lib/znet/index.ts`, line 11, add `VideoSurface` to the type export from `./core.js`:

```ts
export type { PsnesCoreModule, PsnesCoreFactory, VideoFrame, VideoSurface } from './core.js';
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
node --import tsx --test core/test/video-surface.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Register the test file and confirm the whole suite is green**

Append `core/test/video-surface.test.ts` to `test:ui` in `package.json`, then:

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:ui
npm run test:core
```

Expected: both PASS. `test:core` covers determinism and lockstep — it must stay green, because this task touched `core.ts`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/znet/core.ts frontend/src/lib/znet/index.ts core/test/video-surface.test.ts package.json
git commit -m "Let a renderer read the video buffer without the per-frame repack"
```

---

## Task 3: Fetching and resolving a preset

**Files:**
- Create: `frontend/src/lib/znet/shader-source.ts`
- Modify: `frontend/src/lib/znet/index.ts`

**Interfaces:**
- Consumes: `parsePreset`, `resolveShaderUrl`, `Preset`, `PresetPass`, `PresetResult` from `./preset.js` (Task 1).
- Produces:
  - `const SHADER_BASE_URL: string`
  - `interface LoadedPass { source: string; filterLinear: boolean; scale: number | null }`
  - `interface LoadedPreset { passes: LoadedPass[] }`
  - `type LoadResult = { ok: true; preset: LoadedPreset } | { ok: false; reason: string }`
  - `function presetUrl(shaderId: string): string`
  - `function loadShaderPreset(shaderId: string, fetchImpl?: typeof fetch): Promise<LoadResult>`

### Why this is separate from Task 1

Task 1 is pure and therefore testable. This file owns `fetch`, which in this repo means it cannot be unit-tested in Node without a network or a mock harness the project does not have. Keeping the boundary sharp is what makes Task 1's tests worth writing: everything decidable from a string is decided there, and this file only moves bytes.

There are no unit tests in this task. That is deliberate and consistent with the spec, which states plainly that the networked and GL parts are verified in a browser.

- [ ] **Step 1: Write the fetcher**

Create `frontend/src/lib/znet/shader-source.ts`:

```ts
/**
 * Fetches a libretro shader preset and its shader sources.
 *
 * Same repository and same pinned commit as the RetroArch path in
 * `frontend/src/lib/emulator/libs/options.ts`, on purpose: both renderers must
 * show the SAME shader, or the one setting would look different depending on
 * which mode you are playing in.
 *
 * What this does NOT do is reuse that file's `resolveShader`, which carries a
 * hardcoded table of special cases for the three xBRZ presets. A preset names
 * its own files, relative to itself, so ordinary URL resolution covers every
 * preset in the subset - including `shader1 = ../stock.glsl` - and needs no
 * table at all.
 *
 * All the networking for this feature lives here. Everything decidable from a
 * string lives in `preset.ts`, which is why that file has tests and this one
 * does not.
 */

import { parsePreset, resolveShaderUrl } from './preset.js';

/** Pinned to the same commit the RetroArch path uses. */
export const SHADER_BASE_URL =
	'https://cdn.jsdelivr.net/gh/libretro/glsl-shaders@468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7';

export interface LoadedPass {
	/** The full .glsl text, both stages, still carrying its COMPAT macros. */
	source: string;
	filterLinear: boolean;
	scale: number | null;
}

export interface LoadedPreset {
	passes: LoadedPass[];
}

export type LoadResult = { ok: true; preset: LoadedPreset } | { ok: false; reason: string };

/** `xbrz/6xbrz-linear` becomes the pinned URL of `xbrz/6xbrz-linear.glslp`. */
export function presetUrl(shaderId: string): string {
	return `${SHADER_BASE_URL}/${shaderId}.glslp`;
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
	const res = await fetchImpl(url);
	if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
	return res.text();
}

/**
 * Resolves a shader id into ready-to-compile sources.
 *
 * Failure is a returned reason, never a throw: the caller's job on failure is
 * to keep the 2D renderer, which is a normal outcome and not an error the
 * player needs to see as a crash.
 *
 * @param fetchImpl injectable so a caller can supply a cache or a stub
 */
export async function loadShaderPreset(
	shaderId: string,
	fetchImpl: typeof fetch = fetch
): Promise<LoadResult> {
	if (!shaderId) return { ok: false, reason: 'no shader selected' };

	const url = presetUrl(shaderId);

	let presetText: string;
	try {
		presetText = await fetchText(url, fetchImpl);
	} catch (err) {
		return { ok: false, reason: `could not fetch the preset: ${(err as Error).message}` };
	}

	const parsed = parsePreset(presetText);
	if (!parsed.ok) {
		// Name the directive. A preset we cannot honour is the xbrz-freescale
		// case, and the whole point of naming it is that the next person does
		// not have to bisect a black screen to find out why.
		return { ok: false, reason: `unsupported preset directive "${parsed.directive}": ${parsed.reason}` };
	}

	try {
		const passes = await Promise.all(
			parsed.preset.passes.map(async (pass): Promise<LoadedPass> => ({
				source: await fetchText(resolveShaderUrl(url, pass.shaderPath), fetchImpl),
				filterLinear: pass.filterLinear,
				scale: pass.scale
			}))
		);
		return { ok: true, preset: { passes } };
	} catch (err) {
		return { ok: false, reason: `could not fetch a shader: ${(err as Error).message}` };
	}
}
```

- [ ] **Step 2: Export it**

In `frontend/src/lib/znet/index.ts`, add after the `CanvasRenderer` export block (line 37):

```ts
export { parsePreset, resolveShaderUrl, SUPPORTED_DIRECTIVES } from './preset.js';
export type { Preset, PresetPass, PresetResult } from './preset.js';
export { loadShaderPreset, presetUrl, SHADER_BASE_URL } from './shader-source.js';
export type { LoadedPreset, LoadedPass, LoadResult } from './shader-source.js';
```

- [ ] **Step 3: Verify it compiles and the URL scheme is right**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -5
```

Expected: `svelte-check found 0 errors and 19 warnings in 10 files` — that is the measured baseline of this repo before any of this work. A count of 0 errors is the pass condition; the 19 warnings are pre-existing CSS-compatibility notes and are not yours to fix. Any error at all is yours.

Then prove the pinned URLs actually resolve — a typo here fails only at runtime, in a browser:

```bash
for p in xbrz/6xbrz-linear crt/crt-easymode interpolation/sharp-bilinear-simple anti-aliasing/fxaa; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://cdn.jsdelivr.net/gh/libretro/glsl-shaders@468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7/$p.glslp")
  echo "$p -> $code"
done
curl -s -o /dev/null -w 'stock.glsl -> %{http_code}\n' "https://cdn.jsdelivr.net/gh/libretro/glsl-shaders@468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7/stock.glsl"
```

Expected: `200` on all five.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/znet/shader-source.ts frontend/src/lib/znet/index.ts
git commit -m "Fetch presets and their shaders from the same pinned commit RetroArch uses"
```

---

## Task 4: The WebGL2 renderer

**Files:**
- Create: `frontend/src/lib/znet/webgl-renderer.ts`
- Modify: `frontend/src/lib/znet/output.ts` (add `shader` to `DisplayOptions` and `DEFAULT_DISPLAY`; add the `Renderer` interface)
- Modify: `frontend/src/lib/znet/index.ts`

**Interfaces:**
- Consumes: `VideoSurface` and `PsnesCore` from `./core.js` (Task 2); `LoadedPreset`, `LoadedPass` from `./shader-source.js` (Task 3).
- Produces:
  - `interface Renderer { setOptions(options: DisplayOptions): void; draw(core: PsnesCore): void; dispose(): void }` (in `output.ts`)
  - `DisplayOptions.shader: string` (in `output.ts`)
  - `class WebglRenderer implements Renderer` with `static create(canvas: HTMLCanvasElement, preset: LoadedPreset | null): WebglRenderer | null`, plus `setOptions`, `draw`, `dispose`, and a readonly `lost: boolean`.

### The contract, established by reading the six real shaders

Every one of the six declares exactly the same interface and nothing more — verified, not assumed:

- attributes `VertexCoord`, `COLOR`, `TexCoord`
- varyings `COL0`, `TEX0`, plus whatever the shader adds for itself
- uniforms `MVPMatrix`, `FrameDirection`, `FrameCount`, `OutputSize`, `TextureSize`, `InputSize`, and sampler `Texture`

Three rules follow, each with a real failure mode:

1. **Never emit `#version`.** These files branch on `__VERSION__ >= 130`. Without a `#version` line `__VERSION__` is 100, so they take the `attribute`/`varying`/`texture2D` branch and compile as GLSL ES 1.00 — the path they were written for. WebGL2 accepts it.
2. **Never define `PARAMETER_UNIFORM`.** `crt-easymode.glsl` declares 17 parameters as uniforms under that macro and their defaults as `#define` in the `#else` branch. Define it and all 17 sit at zero: a black picture, no compile error.
3. **`COLOR` and `COL0` are declared everywhere and used nowhere**, so the compiler strips them and `getAttribLocation` returns `-1`. Treat `-1` as normal and skip the attribute — do not throw.

- [ ] **Step 1: Add `shader` to the display options and extract the shared interface**

In `frontend/src/lib/znet/output.ts`, replace the `DisplayOptions` interface and `DEFAULT_DISPLAY` (lines 16-36) with:

```ts
/**
 * Display options.
 *
 * All of these are local and cosmetic: they change how a frame is shown, never
 * what the emulator computes, so two players can pick differently without any
 * risk to the lockstep.
 */
export interface DisplayOptions {
	/** false gives the browser's bilinear smoothing instead of hard pixels. */
	pixelPerfect: boolean;
	scanlines: boolean;
	/** 'original' keeps the SNES 8:7-ish pixel aspect; 'stretch' fills. */
	aspect: 'original' | 'stretch';
	/**
	 * A libretro shader id such as `xbrz/6xbrz-linear`, or '' for none.
	 *
	 * Only WebglRenderer honours this; CanvasRenderer has no GL pipeline and
	 * ignores it. Like the rest of this interface it is local and cosmetic and
	 * never crosses the network.
	 */
	shader: string;
}

export const DEFAULT_DISPLAY: DisplayOptions = {
	pixelPerfect: true,
	scanlines: false,
	aspect: 'original',
	shader: ''
};

/**
 * What a room needs from a renderer.
 *
 * Both renderers implement this, so the room picks one at boot and never has
 * to know which it got. Deliberately tiny, and deliberately without any method
 * that could let a renderer influence when a frame runs.
 */
export interface Renderer {
	setOptions(options: DisplayOptions): void;
	draw(core: PsnesCore): void;
	dispose(): void;
}
```

Then give `CanvasRenderer` the `dispose` the interface requires. Add this method at the end of the class, after `draw` (currently line 93):

```ts
	/** Nothing to release: a 2D context holds no GL objects. Here for symmetry. */
	dispose(): void {
		this.image = null;
	}
```

And declare the implementation on line 38:

```ts
export class CanvasRenderer implements Renderer {
```

- [ ] **Step 2: Run the existing suites to confirm the option change broke nothing**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:ui && npm run test:core
```

Expected: PASS. `DisplayOptions` gained a required field, so any code building one literally must be updated — if a test fails to compile, that is the signal, and the fix is to add `shader: ''`.

- [ ] **Step 3: Write the renderer**

Create `frontend/src/lib/znet/webgl-renderer.ts`:

```ts
/**
 * A WebGL2 renderer that runs libretro GLSL shaders.
 *
 * Same interface as CanvasRenderer, so a room picks one at boot and never
 * thinks about it again. Same shaders as the RetroArch path, from the same
 * pinned commit, so one setting looks the same in every mode.
 *
 * ONE RULE ABOVE ALL: this drives nothing. No requestAnimationFrame, no vsync
 * coupling, no dropped frames, no "draw when ready". FrameGovernor is the only
 * timer owner in this stack and NetplaySession decides when a frame exists;
 * this only shows it. A renderer that influenced pacing would make two
 * players' emulation depend on their graphics cards, which is a desync with
 * extra steps.
 *
 * The GL pipeline cannot be unit-tested in this repo - there is no WebGL
 * context under Node and no browser harness here - so it is written to fail
 * into the 2D path rather than to be caught by a test. Every failure returns
 * null or sets `lost`; nothing here throws at the caller.
 */

import type { PsnesCore } from './core.js';
import type { LoadedPass, LoadedPreset } from './shader-source.js';
import { DEFAULT_DISPLAY, type DisplayOptions, type Renderer } from './output.js';

/**
 * Two full-screen quads: position xy, texcoord uv, interleaved.
 *
 * They differ only in whether v is flipped, and getting this wrong shows the
 * game upside down. The reasoning, because it is easy to re-derive wrongly:
 *
 * GL clip space has y = -1 at the BOTTOM, while the uploaded texture has
 * v = 0 on its first row, which is the TOP of the SNES frame. So somewhere the
 * v axis has to be reversed exactly once.
 *
 * Doing it on pass 0 alone is what works for any number of passes. Pass 0
 * flipped means its render target ends up stored bottom-up - the ordinary GL
 * convention - and every later pass, including the one that draws to the
 * canvas, then reads and writes that same convention with no flip at all.
 * Flipping the LAST pass instead would be correct for one pass and wrong for
 * two; flipping every pass would be correct for odd counts only.
 */
const QUAD_FLIPPED = new Float32Array([
	-1, -1, 0, 1,
	 1, -1, 1, 1,
	-1,  1, 0, 0,
	 1,  1, 1, 0
]);

const QUAD_DIRECT = new Float32Array([
	-1, -1, 0, 0,
	 1, -1, 1, 0,
	-1,  1, 0, 1,
	 1,  1, 1, 1
]);

/** Identity, column-major. The quad is already in clip space. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

interface CompiledPass {
	program: WebGLProgram;
	filterLinear: boolean;
	scale: number | null;
	attributes: { vertex: number; texCoord: number; color: number };
	uniforms: {
		mvp: WebGLUniformLocation | null;
		frameDirection: WebGLUniformLocation | null;
		frameCount: WebGLUniformLocation | null;
		outputSize: WebGLUniformLocation | null;
		textureSize: WebGLUniformLocation | null;
		inputSize: WebGLUniformLocation | null;
		texture: WebGLUniformLocation | null;
	};
}

/** A render target for an intermediate pass. The last pass draws to the canvas. */
interface PassTarget {
	framebuffer: WebGLFramebuffer;
	texture: WebGLTexture;
	width: number;
	height: number;
}

/**
 * Splits a libretro .glsl into one stage.
 *
 * The file holds both stages behind `#if defined(VERTEX)` / `#elif
 * defined(FRAGMENT)`, so it is compiled twice with the right macro in front.
 *
 * No `#version` line, ever: these shaders branch on `__VERSION__ >= 130`, and
 * at 100 they take the GLSL ES 1.00 path they were written for. And no
 * PARAMETER_UNIFORM, ever: without it, `#pragma parameter` defaults compile in
 * as #defines. With it, seventeen of crt-easymode's uniforms would sit at zero
 * and the picture would be black with no error.
 */
function stageSource(source: string, stage: 'VERTEX' | 'FRAGMENT'): string {
	return `#define ${stage}\n${source}`;
}

function compileStage(
	gl: WebGL2RenderingContext,
	source: string,
	type: number
): WebGLShader | null {
	const shader = gl.createShader(type);
	if (!shader) return null;
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		gl.deleteShader(shader);
		return null;
	}
	return shader;
}

function buildProgram(gl: WebGL2RenderingContext, source: string): WebGLProgram | null {
	const vertex = compileStage(gl, stageSource(source, 'VERTEX'), gl.VERTEX_SHADER);
	if (!vertex) return null;
	const fragment = compileStage(gl, stageSource(source, 'FRAGMENT'), gl.FRAGMENT_SHADER);
	if (!fragment) {
		gl.deleteShader(vertex);
		return null;
	}

	const program = gl.createProgram();
	if (!program) {
		gl.deleteShader(vertex);
		gl.deleteShader(fragment);
		return null;
	}
	gl.attachShader(program, vertex);
	gl.attachShader(program, fragment);
	gl.linkProgram(program);
	// Attached shaders stay alive until the program is deleted, so releasing
	// our handles now is correct and keeps the driver's object count down.
	gl.deleteShader(vertex);
	gl.deleteShader(fragment);

	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		gl.deleteProgram(program);
		return null;
	}
	return program;
}

function compilePass(gl: WebGL2RenderingContext, pass: LoadedPass): CompiledPass | null {
	const program = buildProgram(gl, pass.source);
	if (!program) return null;

	return {
		program,
		filterLinear: pass.filterLinear,
		scale: pass.scale,
		attributes: {
			// -1 is normal, not an error: COLOR is declared by every one of these
			// shaders and used by none, so the compiler strips it.
			vertex: gl.getAttribLocation(program, 'VertexCoord'),
			texCoord: gl.getAttribLocation(program, 'TexCoord'),
			color: gl.getAttribLocation(program, 'COLOR')
		},
		uniforms: {
			mvp: gl.getUniformLocation(program, 'MVPMatrix'),
			frameDirection: gl.getUniformLocation(program, 'FrameDirection'),
			frameCount: gl.getUniformLocation(program, 'FrameCount'),
			outputSize: gl.getUniformLocation(program, 'OutputSize'),
			textureSize: gl.getUniformLocation(program, 'TextureSize'),
			inputSize: gl.getUniformLocation(program, 'InputSize'),
			texture: gl.getUniformLocation(program, 'Texture')
		}
	};
}

export class WebglRenderer implements Renderer {
	private gl: WebGL2RenderingContext;
	private canvas: HTMLCanvasElement;
	private passes: CompiledPass[];
	private options: DisplayOptions = { ...DEFAULT_DISPLAY };

	private flippedQuad: WebGLBuffer | null = null;
	private directQuad: WebGLBuffer | null = null;
	private inputTexture: WebGLTexture | null = null;
	private targets: PassTarget[] = [];

	/** Dimensions the current textures were allocated for. */
	private inputWidth = 0;
	private inputHeight = 0;

	private frameCount = 0;
	private contextLost = false;
	private onContextLost: (event: Event) => void;

	/**
	 * Builds a renderer, or returns null so the caller keeps the 2D one.
	 *
	 * Null covers every reason this cannot run: no WebGL2, no preset, a preset
	 * with no passes, or a shader that will not compile or link. The caller
	 * never has to distinguish them - the response to all of them is the same.
	 */
	static create(canvas: HTMLCanvasElement, preset: LoadedPreset | null): WebglRenderer | null {
		if (!preset || preset.passes.length === 0) return null;

		const gl = canvas.getContext('webgl2', {
			alpha: false,
			antialias: false,
			depth: false,
			stencil: false,
			// The picture must survive until the next draw: a lockstep stall means
			// no new frame for a while, and a cleared canvas would flash black.
			preserveDrawingBuffer: true
		});
		if (!gl) return null;

		const compiled: CompiledPass[] = [];
		for (const pass of preset.passes) {
			const built = compilePass(gl, pass);
			if (!built) {
				for (const done of compiled) gl.deleteProgram(done.program);
				return null;
			}
			compiled.push(built);
		}

		return new WebglRenderer(canvas, gl, compiled);
	}

	private constructor(
		canvas: HTMLCanvasElement,
		gl: WebGL2RenderingContext,
		passes: CompiledPass[]
	) {
		this.canvas = canvas;
		this.gl = gl;
		this.passes = passes;

		this.flippedQuad = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.flippedQuad);
		gl.bufferData(gl.ARRAY_BUFFER, QUAD_FLIPPED, gl.STATIC_DRAW);

		this.directQuad = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.directQuad);
		gl.bufferData(gl.ARRAY_BUFFER, QUAD_DIRECT, gl.STATIC_DRAW);

		// A laptop switching graphics cards, or a driver reset, kills the context
		// without warning. Untreated, the game becomes a black screen with no
		// message; treated, the room falls back to 2D and keeps playing.
		this.onContextLost = (event: Event) => {
			event.preventDefault();
			this.contextLost = true;
		};
		canvas.addEventListener('webglcontextlost', this.onContextLost);

		this.applyOptions();
	}

	/** True once the GL context died. The room watches this and swaps to 2D. */
	get lost(): boolean {
		return this.contextLost;
	}

	setOptions(options: DisplayOptions): void {
		this.options = { ...options };
		this.applyOptions();
	}

	/**
	 * Only the CSS-level options apply here.
	 *
	 * `pixelPerfect` does not: filtering is the preset's business, set per pass
	 * from `filter_linearN`, and overriding it would make the shader look
	 * different from the same shader in the RetroArch path. `scanlines` does
	 * not either - crt-easymode draws its own, and stacking a second set over
	 * a shader that already has them looks wrong.
	 */
	private applyOptions(): void {
		this.canvas.style.imageRendering = this.options.pixelPerfect ? 'pixelated' : 'auto';
		this.canvas.style.objectFit = this.options.aspect === 'stretch' ? 'fill' : 'contain';
	}

	draw(core: PsnesCore): void {
		if (this.contextLost) return;

		const surface = core.videoSurface();
		if (surface.width === 0 || surface.height === 0) return;

		const gl = this.gl;

		if (surface.width !== this.inputWidth || surface.height !== this.inputHeight) {
			// The SNES switches between 256x224, 512x448 and interlaced modes. A
			// fixed-size texture would show noise the first time a game opens a
			// high-resolution menu.
			this.allocate(surface.width, surface.height);
		}

		this.upload(surface.data, surface.width, surface.height, surface.stride);

		// The final pass draws to the canvas, so the canvas must be the size the
		// last pass expects to fill.
		const finalWidth = this.canvasWidth(surface.width);
		const finalHeight = this.canvasHeight(surface.height);
		if (this.canvas.width !== finalWidth || this.canvas.height !== finalHeight) {
			this.canvas.width = finalWidth;
			this.canvas.height = finalHeight;
		}

		let inputTexture = this.inputTexture;
		let inputWidth = surface.width;
		let inputHeight = surface.height;

		for (let i = 0; i < this.passes.length; i++) {
			const pass = this.passes[i];
			const last = i === this.passes.length - 1;
			const target = last ? null : this.targets[i];
			const outWidth = last ? finalWidth : target!.width;
			const outHeight = last ? finalHeight : target!.height;

			gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
			gl.viewport(0, 0, outWidth, outHeight);
			gl.useProgram(pass.program);

			// Pass 0 flips v; everything after it inherits that flip. See the
			// comment on QUAD_FLIPPED - this is the difference between the game
			// being right side up and upside down.
			gl.bindBuffer(gl.ARRAY_BUFFER, i === 0 ? this.flippedQuad : this.directQuad);

			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, inputTexture);
			const filter = pass.filterLinear ? gl.LINEAR : gl.NEAREST;
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);

			if (pass.uniforms.texture) gl.uniform1i(pass.uniforms.texture, 0);
			if (pass.uniforms.mvp) gl.uniformMatrix4fv(pass.uniforms.mvp, false, IDENTITY);
			// Forward only: the display never replays backwards, even when the
			// session rewinds internally to resync.
			if (pass.uniforms.frameDirection) gl.uniform1i(pass.uniforms.frameDirection, 1);
			if (pass.uniforms.frameCount) gl.uniform1i(pass.uniforms.frameCount, this.frameCount);
			if (pass.uniforms.inputSize) gl.uniform2f(pass.uniforms.inputSize, inputWidth, inputHeight);
			if (pass.uniforms.textureSize) {
				gl.uniform2f(pass.uniforms.textureSize, inputWidth, inputHeight);
			}
			if (pass.uniforms.outputSize) gl.uniform2f(pass.uniforms.outputSize, outWidth, outHeight);

			this.bindQuad(pass);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			this.unbindQuad(pass);

			if (!last) {
				inputTexture = target!.texture;
				inputWidth = target!.width;
				inputHeight = target!.height;
			}
		}

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		this.frameCount = (this.frameCount + 1) >>> 0;
	}

	/** Width of the last pass's output: the input, times every earlier scale. */
	private canvasWidth(sourceWidth: number): number {
		return Math.max(1, Math.round(sourceWidth * this.totalScale()));
	}

	private canvasHeight(sourceHeight: number): number {
		return Math.max(1, Math.round(sourceHeight * this.totalScale()));
	}

	/**
	 * The product of the intermediate passes' scales.
	 *
	 * The final pass has no render target of its own, so its own `scale` is
	 * irrelevant - it fills whatever the canvas is. Only the passes before it
	 * multiply the picture up.
	 */
	private totalScale(): number {
		let scale = 1;
		for (let i = 0; i < this.passes.length - 1; i++) {
			scale *= this.passes[i].scale ?? 1;
		}
		return scale;
	}

	private bindQuad(pass: CompiledPass): void {
		const gl = this.gl;
		const stride = 4 * Float32Array.BYTES_PER_ELEMENT;

		if (pass.attributes.vertex >= 0) {
			gl.enableVertexAttribArray(pass.attributes.vertex);
			// The shaders declare VertexCoord as a vec4 and read .xy/.z/.w in the
			// MVP multiply, so the unsupplied z,w must be 0,1 - which is exactly
			// what WebGL fills in for a size-2 attribute.
			gl.vertexAttribPointer(pass.attributes.vertex, 2, gl.FLOAT, false, stride, 0);
		}
		if (pass.attributes.texCoord >= 0) {
			gl.enableVertexAttribArray(pass.attributes.texCoord);
			gl.vertexAttribPointer(
				pass.attributes.texCoord,
				2,
				gl.FLOAT,
				false,
				stride,
				2 * Float32Array.BYTES_PER_ELEMENT
			);
		}
		if (pass.attributes.color >= 0) {
			// Declared by all six shaders, used by none - so it usually is -1. If a
			// driver keeps it, white is the neutral value.
			gl.disableVertexAttribArray(pass.attributes.color);
			gl.vertexAttrib4f(pass.attributes.color, 1, 1, 1, 1);
		}
	}

	private unbindQuad(pass: CompiledPass): void {
		const gl = this.gl;
		if (pass.attributes.vertex >= 0) gl.disableVertexAttribArray(pass.attributes.vertex);
		if (pass.attributes.texCoord >= 0) gl.disableVertexAttribArray(pass.attributes.texCoord);
	}

	/**
	 * Uploads the frame straight out of wasm memory.
	 *
	 * UNPACK_ROW_LENGTH is what makes the zero-copy path work: the core's rows
	 * are 512 pixels wide whatever the visible width is, and this tells GL to
	 * step by that while reading only `width` pixels of each. Without it the
	 * frame has to be repacked on the CPU every single time.
	 *
	 * It is reset to 0 afterwards because it is global context state, and
	 * leaving it set would corrupt any later upload that assumes the default.
	 */
	private upload(data: Uint8Array, width: number, height: number, stride: number): void {
		const gl = this.gl;
		gl.bindTexture(gl.TEXTURE_2D, this.inputTexture);
		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
		gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
	}

	/** (Re)allocates the input texture and every intermediate render target. */
	private allocate(width: number, height: number): void {
		const gl = this.gl;
		this.releaseTextures();

		this.inputTexture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, this.inputTexture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

		let passWidth = width;
		let passHeight = height;
		for (let i = 0; i < this.passes.length - 1; i++) {
			const scale = this.passes[i].scale ?? 1;
			passWidth = Math.max(1, Math.round(passWidth * scale));
			passHeight = Math.max(1, Math.round(passHeight * scale));

			const texture = gl.createTexture()!;
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.texImage2D(
				gl.TEXTURE_2D, 0, gl.RGBA, passWidth, passHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null
			);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

			const framebuffer = gl.createFramebuffer()!;
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.framebufferTexture2D(
				gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0
			);
			if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
				// This is the xbrz-freescale failure, arriving from the other side:
				// a target too large for the driver. Give up on GL rather than draw
				// nothing - the room will keep the 2D renderer.
				gl.bindFramebuffer(gl.FRAMEBUFFER, null);
				this.contextLost = true;
				return;
			}

			this.targets.push({ framebuffer, texture, width: passWidth, height: passHeight });
		}

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		this.inputWidth = width;
		this.inputHeight = height;
	}

	private releaseTextures(): void {
		const gl = this.gl;
		for (const target of this.targets) {
			gl.deleteFramebuffer(target.framebuffer);
			gl.deleteTexture(target.texture);
		}
		this.targets = [];
		if (this.inputTexture) {
			gl.deleteTexture(this.inputTexture);
			this.inputTexture = null;
		}
		this.inputWidth = 0;
		this.inputHeight = 0;
	}

	dispose(): void {
		this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
		this.releaseTextures();
		if (this.flippedQuad) {
			this.gl.deleteBuffer(this.flippedQuad);
			this.flippedQuad = null;
		}
		if (this.directQuad) {
			this.gl.deleteBuffer(this.directQuad);
			this.directQuad = null;
		}
		for (const pass of this.passes) this.gl.deleteProgram(pass.program);
		this.passes = [];
	}
}
```

- [ ] **Step 4: Export it**

In `frontend/src/lib/znet/index.ts`, extend the output export line (line 36-37) and add the renderer:

```ts
export { CanvasRenderer, AudioSink, DEFAULT_DISPLAY } from './output.js';
export type { DisplayOptions, Renderer } from './output.js';
export { WebglRenderer } from './webgl-renderer.js';
```

- [ ] **Step 5: Verify it type-checks, and that the timing rule holds**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -5
```

Expected: still `0 errors` (the baseline is 0 errors and 19 warnings in 10 files). The warning count may rise slightly if you add CSS; errors may not.

Now check the constraint that matters most, mechanically:

```bash
grep -nE "requestAnimationFrame|setTimeout|setInterval|performance\.now|Date\.now" \
  frontend/src/lib/znet/webgl-renderer.ts frontend/src/lib/znet/preset.ts \
  frontend/src/lib/znet/shader-source.ts
```

Expected: **no output at all**. Any hit means the renderer has acquired a clock, which is the one defect in this feature that could desync a game. If there is a hit, remove it before committing.

```bash
grep -n "PARAMETER_UNIFORM\|#version" frontend/src/lib/znet/webgl-renderer.ts
```

Expected: matches only inside comments explaining why neither is emitted — never in a template literal that reaches a shader.

- [ ] **Step 6: Run the full unit suite**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run test:all
```

Expected: PASS throughout. The measured baseline before this plan is **165 tests, 0 failures** — 37 netplay, 11 core, 51 ui, 66 backend. Tasks 1 and 2 add 20 and 6 tests to the `ui` group, so by this step the expected totals are 37 / 11 / 77 / 66 = 191.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/znet/webgl-renderer.ts frontend/src/lib/znet/output.ts frontend/src/lib/znet/index.ts
git commit -m "Run the real libretro shaders on the lockstep canvas, or fall back to 2D"
```

---

## Task 5: Wire it into the room

**Files:**
- Modify: `frontend/src/lib/components/LockstepRoom.svelte` (imports around line 24-27; `renderer` declaration line 74; `display` line 113; the save adapter line 158-160; the reactive statement line 162; `boot()` around line 319 and the governor at 366-372; the canvas at line 848; the toolbar around line 896-909; `teardown()` at line 785; the `<style>` block)

**Interfaces:**
- Consumes: `WebglRenderer.create(canvas, preset)`, `loadShaderPreset(shaderId)`, `Renderer`, `DisplayOptions` (now with `shader: string`), `DEFAULT_DISPLAY`.
- Produces: nothing for later tasks.

### Two canvases, because a canvas cannot change context type

A canvas that has handed out a `webgl2` context will **never** return a `2d` one, and the reverse holds too. So switching renderers cannot reuse one element.

Replacing the element at runtime is the wrong fix: `<canvas bind:this={canvas}>` means Svelte holds its own reference for mounting, directives and cleanup, and swapping the node underneath leaves Svelte operating on a detached element. Instead the markup declares **both** canvases and hides one. Svelte owns both, each keeps a single context type for the session's whole life, and switching is a boolean.

### The Svelte 4 reactivity trap in this file

`$: if (renderer && display) renderer.setOptions(display)` at line 162 works because it *reads* both names in the block. Svelte 4 tracks dependencies syntactically and **does not trace into function bodies** — a dependency that only appears inside a called function is never tracked, and the block silently stops re-running. Keep every value a reactive block depends on read directly in the block.

The shader swap is therefore an explicit call, not a reactive statement: it is async, and a reactive block would re-fire it on every unrelated `display` change.

### No i18n in this task

`LockstepRoom.svelte` uses no translations at all — its entire UI is hardcoded English (`Scanlines`, `Sharp`, `Fit`, `Stretch`, `Fullscreen`, `Show netplay stats`). The notice follows that, in English, in the component. Adding two keys to `translations.ts` plus two imports for one string would make this the only translated line in a 1179-line untranslated component. `translations.ts` is not touched by this task.

- [ ] **Step 1: Update the imports and state**

In `LockstepRoom.svelte`, change the type-only znet import (line 24) to also bring in `Renderer`:

```ts
  import { DEFAULT_DISPLAY, type DisplayOptions, type Renderer } from '$lib/znet';
```

and add three names to the import list that currently supplies `CanvasRenderer` (line 27):

```ts
    CanvasRenderer,
    WebglRenderer,
    loadShaderPreset,
```

Replace the single canvas variable (line 53) with one per context type:

```ts
  /**
   * One canvas per context type.
   *
   * A canvas that has produced a webgl2 context can never produce a 2d one, so
   * switching renderers means switching elements. Both are declared in the
   * markup and one is hidden, which keeps Svelte the owner of both - replacing
   * a bound element at runtime would leave Svelte holding a detached node.
   */
  let canvas2d: HTMLCanvasElement;
  let canvasGl: HTMLCanvasElement;
  let usingGl = false;
```

Change the renderer declaration (line 74) to the interface, so the room genuinely cannot tell which one it holds:

```ts
  let renderer: Renderer | null = null;
```

Add state next to `display` (line 113):

```ts
  let display: DisplayOptions = { ...DEFAULT_DISPLAY };
  /** Set when a shader was asked for and could not be delivered. Plain English, like the rest of this component. */
  let shaderNotice: string | null = null;
  /** Guards against overlapping swaps when the player clicks the button quickly. */
  let shaderSwapToken = 0;
```

- [ ] **Step 2: Point the derived values at the active canvas**

Replace the save adapter (lines 158-160) and add the derived canvas above it:

```ts
  $: activeCanvas = usingGl ? canvasGl : canvas2d;

  $: saveAdapter = core
    ? { saveState: async () => core!.saveState(), getCanvas: () => activeCanvas }
    : null;
```

`getCanvas` reads `activeCanvas` at call time, so a shader swap between opening the save menu and pressing the button still photographs the canvas that is actually on screen.

- [ ] **Step 3: Declare both canvases in the markup**

Replace line 848 (`<canvas bind:this={canvas} width="256" height="224"></canvas>`) with:

```svelte
    <canvas bind:this={canvas2d} class:inactive={usingGl} width="256" height="224"></canvas>
    <canvas bind:this={canvasGl} class:inactive={!usingGl} width="256" height="224"></canvas>

    {#if shaderNotice}
      <p class="shader-notice">{shaderNotice}</p>
    {/if}
```

And add to the `<style>` block, next to the existing `canvas` rule (line 995):

```css
  canvas.inactive {
    display: none;
  }

  .shader-notice {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    margin: 0;
    padding: 0.35rem 0.6rem;
    background: rgba(0, 0, 0, 0.6);
    color: #e0b040;
    font-size: 0.8rem;
    text-align: center;
  }
```

- [ ] **Step 4: Add the swap function**

Add this above the reactive statements, near the other display helpers:

```ts
  /** The same six the home page offers, in the same order, plus none. */
  const SHADER_IDS = [
    '',
    'xbrz/6xbrz-linear',
    'xbrz/5xbrz-linear',
    'xbrz/4xbrz-linear',
    'crt/crt-easymode',
    'interpolation/sharp-bilinear-simple',
    'anti-aliasing/fxaa'
  ];

  function shaderLabel(id: string): string {
    if (!id) return 'No shader';
    // The id's last segment is short enough for a toolbar button.
    return id.split('/').pop() as string;
  }

  /** Drops back to the 2D renderer on its own canvas. Always succeeds. */
  function useCanvasRenderer(): void {
    renderer?.dispose();
    usingGl = false;
    renderer = new CanvasRenderer(canvas2d);
    renderer.setOptions(display);
    if (core) renderer.draw(core);
  }

  /**
   * Switches the renderer to run `shaderId`, or keeps 2D and says why.
   *
   * Every failure lands in the same place: a working 2D renderer plus a
   * notice. The player is never left looking at a black canvas wondering
   * whether the game crashed - which is exactly what xbrz-freescale used to do
   * before it was removed from the shader list.
   */
  async function applyShader(shaderId: string): Promise<void> {
    const token = ++shaderSwapToken;
    shaderNotice = null;

    if (!shaderId) {
      useCanvasRenderer();
      return;
    }

    const loaded = await loadShaderPreset(shaderId);
    // The player may have picked something else while this was fetching.
    if (token !== shaderSwapToken) return;

    if (!loaded.ok) {
      logger.warn('shader unavailable', { shaderId, reason: loaded.reason });
      shaderNotice = 'That shader could not be loaded; showing raw pixels.';
      useCanvasRenderer();
      return;
    }

    renderer?.dispose();

    const webgl = WebglRenderer.create(canvasGl, loaded.preset);
    if (!webgl) {
      logger.warn('webgl2 unavailable or the shader would not compile', { shaderId });
      shaderNotice = 'Shaders need WebGL2, which this browser did not provide.';
      useCanvasRenderer();
      return;
    }

    usingGl = true;
    renderer = webgl;
    renderer.setOptions(display);
    if (core) renderer.draw(core);
  }

  async function cycleShader(): Promise<void> {
    const next = SHADER_IDS[(SHADER_IDS.indexOf(display.shader) + 1) % SHADER_IDS.length];
    display = { ...display, shader: next };
    // Local and cosmetic, so it is remembered exactly the way the home page's
    // settings modal remembers it - same key, same meaning.
    if (next) localStorage.setItem('psnes-shader', next);
    else localStorage.removeItem('psnes-shader');
    await applyShader(next);
  }

  /**
   * Falls back to 2D if the GL context died mid-game.
   *
   * Polled from the governor's existing slice callback rather than from an
   * event handler here: the renderer is the only thing that knows, and giving
   * it a way to call back into the room is exactly the coupling this design
   * refuses. One boolean read per slice, and no new timer.
   */
  function checkRendererHealth(): void {
    if (renderer instanceof WebglRenderer && renderer.lost) {
      logger.warn('webgl context lost, falling back to 2D');
      shaderNotice = 'The graphics context was lost; showing raw pixels.';
      useCanvasRenderer();
    }
  }
```

- [ ] **Step 5: Build the right renderer at boot**

Replace lines 319-320 (`renderer = new CanvasRenderer(canvas); renderer.draw(core);`) with:

```ts
      // The shader preference is global and already set from the home page's
      // settings modal; the lockstep path simply never honoured it until now.
      const storedShader = localStorage.getItem('psnes-shader') || '';
      display = { ...display, shader: storedShader };

      renderer = new CanvasRenderer(canvas2d);
      renderer.draw(core);

      // Then try to upgrade to GL. Deliberately after a first frame is already
      // on screen: fetching a preset takes a moment, and a visible picture
      // beats an empty canvas while it loads.
      if (storedShader) await applyShader(storedShader);
```

- [ ] **Step 6: Detect context loss from the existing slice callback**

In `boot()`, extend the governor's `onSlice` (around line 368) — it already runs once per scheduler slice:

```ts
        onSlice: (ran, stalled) => {
          setStalling(stalled && ran === 0);
          stats = session!.getStats();
          checkRendererHealth();
        }
```

- [ ] **Step 7: Add the toolbar control**

After the `Fit`/`Stretch` button (line 909), add a cycler. A `<select>` would be tidier, but the toolbar is all buttons — match what is there.

```svelte
    <button
      class="action"
      class:on={display.shader !== ''}
      on:click={cycleShader}
      title="Shader"
    >{shaderLabel(display.shader)}</button>
```

- [ ] **Step 8: Dispose the renderer on teardown**

In `teardown()` (line 785), alongside the other cleanup:

```ts
    renderer?.dispose();
    renderer = null;
```

- [ ] **Step 9: Verify it type-checks and the suite is green**

```bash
export PATH="$HOME/.nvm/versions/node/v20.19.6/bin:$PATH"
npm run check --workspace frontend 2>&1 | tail -5
npm run test:all
```

Expected: still `0 errors` against the measured baseline of 0 errors and 19 warnings, and all tests PASS. In particular there must be no remaining reference to a bare `canvas` variable in this component — the two-canvas change renames it, and `svelte-check` is what catches a missed one.

```bash
grep -n "bind:this={canvas}\|getCanvas: () => canvas\b" frontend/src/lib/components/LockstepRoom.svelte
```

Expected: no output. A hit means an old reference survived.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/lib/components/LockstepRoom.svelte
git commit -m "Honour the shader setting in a lockstep room, and say so when it cannot"
```

---

## Task 6: Browser verification

**Files:** none modified. This task produces a written record.

**Interfaces:** consumes everything from Tasks 1-5.

### Why this is a task and not a footnote

The spec is explicit that the GL pipeline cannot be unit-tested in this repo — no WebGL context under Node, no browser harness, and the existing Playwright tests never load a ROM. This task is the compensating control, and its output is a report, so the next person knows exactly what was and was not observed.

- [ ] **Step 1: Bring the stack up**

```bash
npm run dev
```

Wait for the frontend to be reachable. Expect a cold start of a few seconds, not minutes — if it takes 300s, something regressed in the Docker/Bun setup and that is a separate problem worth reporting.

- [ ] **Step 2: Walk the six shaders in a lockstep room**

Open two browser windows, join the same room, start a game. In one window, click the shader button through all seven states (no shader plus the six presets). For each, record:

- whether the picture is correct (not black, not garbled, not stretched wrong)
- whether the other window is unaffected (it must be — the setting is local)
- any console error

The three xBRZ presets are the two-pass path; `crt-easymode` is the `#pragma parameter` path; `sharp-bilinear-simple` is the plain single pass; `fxaa` is the `scale0 = 1.0` path. All four shapes must be exercised.

- [ ] **Step 3: Run the check that matters more than any screenshot**

With `crt/crt-easymode` selected and again with no shader, read the netplay stats panel and record the frame rate and input delay over about 30 seconds each.

The rule: **frame pacing must be the same with and without a shader.** If enabling a shader changes emulated frames per second, the renderer is influencing timing and the feature is not finished — that is the one defect here that could desync a game. Report the two numbers side by side.

Then repeat with `xbrz/6xbrz-linear`, which is the most expensive preset and therefore the likeliest to reveal it.

- [ ] **Step 4: Force each fallback and confirm it is graceful**

Four cases, each of which must end with a visible picture and a notice rather than a black screen:

1. **No WebGL2** — in Chrome, launch with `--disable-gpu` or disable hardware acceleration, then pick a shader. Expect the raw picture plus the `shaderNoWebgl` notice.
2. **Unsupported preset** — temporarily point `SHADER_IDS` at a preset with a viewport scale (`xbrz/xbrz-freescale`), pick it, and confirm the console names the offending directive rather than showing a black canvas. Revert the edit afterwards.
3. **Fetch failure** — block `cdn.jsdelivr.net` in devtools' network conditions, pick a shader, expect the `shaderUnavailable` notice.
4. **Context loss** — in the console, run `document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext()` and confirm the game keeps playing in 2D.

- [ ] **Step 5: Check the resolution switch**

Play a game that changes video mode — a high-resolution menu — and confirm the picture stays correct across the switch with a shader active. This is the reallocation path; a fixed-size texture shows noise here.

- [ ] **Step 6: Write the report**

Create `docs/superpowers/verification/2026-08-20-webgl-renderer.md` with: the browser and GPU used, the six shaders and their outcome, the two frame-pacing measurements side by side, the four fallbacks and what each produced, the resolution-switch result, and anything observed but not fixed.

If the per-emulated-frame draw noted in the spec produces visible stutter with 6xbrz after a network stall, record the observation with numbers. Do not fix it in this task — the fix touches the 2D path too and is outside this spec.

- [ ] **Step 7: Commit the report**

```bash
git add docs/superpowers/verification/2026-08-20-webgl-renderer.md
git commit -m "Record what the browser actually showed, including what stayed unverified"
```

---

## Self-Review

**1. Spec coverage.** Walked each spec section against the plan:

| Spec section | Task |
|---|---|
| Why now / the sequencing argument | context only, no task needed |
| The six presets and the five-directive subset | Task 1 (`parsePreset`, refusal tests) |
| The shader file contract, no `#version`, no `PARAMETER_UNIFORM` | Task 4 (`stageSource`, plus the grep in Step 5) |
| Second renderer behind the same interface, four fallbacks | Task 4 (`create` returns null) + Task 5 (`applyShader`) + Task 6 Step 4 |
| The interpreter and its refusals, relative path resolution | Task 1 |
| Fetching from the same pinned commit | Task 3 |
| The passes, `InputSize`/`TextureSize`/`OutputSize`/`FrameCount`/`FrameDirection` | Task 4 (`draw`) |
| Zero-copy upload with `UNPACK_ROW_LENGTH` | Task 2 (`videoSurface`) + Task 4 (`upload`) |
| Resolution-change reallocation | Task 4 (`allocate`) + Task 6 Step 5 |
| The renderer drives nothing | Global Constraints + Task 4 Step 5 grep + Task 6 Step 3 |
| Options stay local | Task 5 (localStorage, never the protocol) |
| No shader parameter UI | honoured by omission; no task creates one |
| Testable: the interpreter | Task 1 (20 tests) |
| Not testable: the GL pipeline | Task 6, and stated as such |
| Frame-pacing check as the decisive control | Task 6 Step 3 |
| What comes after (solo migration) | out of scope, no task |

No gaps found.

**2. Placeholder scan.** No TBD, no "add error handling", no "similar to Task N". Every code step carries the actual code. Task 6 is prose because its deliverable is an observation, and each of its steps names the exact thing to do and the exact expected outcome.

**3. Type consistency.** Checked the names that cross task boundaries:

- `PresetResult` / `Preset` / `PresetPass` — defined Task 1, consumed Task 3. Field names `shaderPath`, `filterLinear`, `scale` are used identically in both.
- `LoadedPreset` / `LoadedPass` — defined Task 3, consumed Task 4 (`WebglRenderer.create`, `compilePass`). `source`, `filterLinear`, `scale` line up.
- `VideoSurface` — defined Task 2, consumed Task 4 (`draw` reads `.data`, `.width`, `.height`, `.stride`). Matches.
- `Renderer` — defined Task 4 in `output.ts`, consumed Task 5 as the type of `renderer`. `setOptions`/`draw`/`dispose` are all three implemented by both renderers; `CanvasRenderer.dispose` is added in Task 4 Step 1 specifically so the interface holds.
- `DisplayOptions.shader` — added Task 4 Step 1, read in Task 5. `DEFAULT_DISPLAY` gains the matching `shader: ''` in the same step, which is what keeps existing object literals valid.
- `loadShaderPreset` — Task 3, called in Task 5. Returns `LoadResult`, and Task 5 branches on `.ok` then reads `.preset` / `.reason` accordingly.

Two real defects found and fixed while checking, both in Task 5:

- **The original draft reused one canvas element for both renderers.** That cannot work: a canvas that has produced a `webgl2` context will never return a `2d` one. The first fix — replacing the element at runtime — was worse, because `bind:this` means Svelte holds its own reference for directives and cleanup, so swapping the node underneath leaves Svelte operating on a detached element. The plan now declares both canvases in the markup and hides one, which keeps Svelte the owner of both.
- **The original draft added two i18n keys** to `translations.ts` and called `t($language, …)`. But `LockstepRoom.svelte` imports no i18n at all — its whole UI is hardcoded English. One translated line in an otherwise untranslated 1179-line component is worse than none, so the notice is plain English and `translations.ts` is no longer touched.

Knock-on checked: the save-thumbnail adapter's `getCanvas: () => activeCanvas` reads the derived value at call time, so a shader swap between opening the save menu and pressing the button still photographs the canvas that is on screen.

## Risks recorded, not solved

- **`draw()` runs per emulated frame, not per displayed frame.** After a stall the governor runs up to 8 ticks in one slice, so the GL pipeline runs up to 8 times for one visible frame. Existing behaviour, made more expensive by 6xbrz. Not a desync risk; a stutter risk. Task 6 Step 6 records it if seen.
- **Two canvases exist, one hidden.** Any future code that reaches for "the canvas" must go through `activeCanvas`, not either element directly. A `document.querySelector('canvas')` anywhere in this component would now find the 2D one whether or not it is the visible one.
- **`preserveDrawingBuffer: true` costs some performance** on some drivers. It is there because a lockstep stall means no new frame for a while and a cleared buffer would flash black. If Task 6 Step 3 shows a pacing difference, this is the first thing to test without.
