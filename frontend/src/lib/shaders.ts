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

/**
 * `preview` is a still of that shader's own output, captured from the same
 * frame for every entry so the pictures differ only by the shader. They are
 * screenshots rather than something rendered live: a preview does not need a
 * WebGL context per tile to show what a filter does to an edge.
 */
export const SHADERS = [
  { id: '', name: 'shaderNone' as const, preview: '/shaders/raw.png' },
  { id: 'xbrz/6xbrz-linear', name: 'shaderXbrz6x' as const, preview: '/shaders/xbrz-6x.png' },
  { id: 'xbrz/5xbrz-linear', name: 'shaderXbrz5x' as const, preview: '/shaders/xbrz-5x.png' },
  { id: 'xbrz/4xbrz-linear', name: 'shaderXbrz4x' as const, preview: '/shaders/xbrz-4x.png' },
  {
    id: 'interpolation/sharp-bilinear-simple',
    name: 'shaderSharpBilinear' as const,
    preview: '/shaders/sharp-bilinear.png'
  },
  { id: 'anti-aliasing/fxaa', name: 'shaderFxaa' as const, preview: '/shaders/fxaa.png' },
] as const;

export const VALID_SHADER_IDS: readonly string[] = SHADERS.map(s => s.id);
