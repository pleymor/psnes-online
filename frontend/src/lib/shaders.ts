/**
 * Available shaders from libretro/glsl-shaders repository.
 *
 * This list is the single source of truth for both rendering paths: the
 * RetroArch stack and the lockstep WebGL renderer both read it, so removing
 * an entry here removes it from every mode at once.
 *
 * Two are deliberately absent:
 * - xbrz-freescale, because its viewport-based scaling causes WebGL
 *   framebuffer errors in the WASM emulator.
 * - crt-easymode, dropped on the owner's call. It also happened to be the
 *   preset most damaged by the lockstep renderer's final pass running at
 *   source size rather than at the viewport: at 1:1 its scanline term
 *   evaluates to a constant, so the scanlines vanished entirely.
 */

export const SHADERS = [
	{ id: '', name: 'shaderNone' as const },
	{ id: 'xbrz/6xbrz-linear', name: 'shaderXbrz6x' as const },
	{ id: 'xbrz/5xbrz-linear', name: 'shaderXbrz5x' as const },
	{ id: 'xbrz/4xbrz-linear', name: 'shaderXbrz4x' as const },
	{ id: 'interpolation/sharp-bilinear-simple', name: 'shaderSharpBilinear' as const },
	{ id: 'anti-aliasing/fxaa', name: 'shaderFxaa' as const },
] as const;

export const VALID_SHADER_IDS: readonly string[] = SHADERS.map(s => s.id);
