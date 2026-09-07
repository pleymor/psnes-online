/**
 * How much resolution to ask the headset for, in one three-free module.
 *
 * three never sets this, so its default stands: `framebufferScaleFactor = 1.0`
 * (`WebXRManager.js:42`, read at `:435`/`:476` when the layer is created).
 * 1.0 is NOT the panel's resolution - it is the scale the runtime recommends,
 * and a runtime recommends with one eye on its own frame budget. On a Quest
 * the native factor is above 1, which means every session so far has been
 * rendering below what the hardware can show.
 *
 * That is felt most on the curved screen: 256 texels across a 60 degree arc is
 * 4.3 texels per degree against roughly 20 pixels per degree in the headset, so
 * the picture is magnified about fourfold and every sample the framebuffer does
 * not have is a step of visible snapping when the head moves.
 *
 * The layer constructor is a parameter for the reason `xr-session.ts` gives
 * about its navigator: so it can be tested without a headset.
 */

/**
 * The ceiling, and the one number here that is not measured.
 *
 * Fill rate goes as the square of this, so a runaway value would cost the
 * emulator its 60.0988 Hz - and `FrameGovernor` would start dropping frames
 * rather than tearing, which is audible before it is visible. 2 is a
 * guardrail against a nonsense answer, not a tuning choice: no shipping
 * headset reports a native factor near it. This scene is four unlit quads and
 * two lines, so if anything ever does need turning down, it is this constant
 * and nothing else - which is why it lives here rather than inline.
 */
export const MAX_FRAMEBUFFER_SCALE = 2;

/** The part of `XRWebGLLayer` this module touches. */
export interface NativeScaleReporter {
  getNativeFramebufferScaleFactor?(session: XRSession): number;
}

/**
 * The scale to hand `renderer.xr.setFramebufferScaleFactor`.
 *
 * Clamped to `[1, MAX_FRAMEBUFFER_SCALE]`, and both ends earn their keep. The
 * floor is 1 because that is the runtime's recommendation: a native factor
 * below it would mean the default was already giving us more than native, and
 * obeying it would throw resolution away. Anything unusable - the static
 * absent, or an answer of 0, NaN or a string - also falls back to 1, never to
 * 0: a zero-sized framebuffer is a black headset, which reads as a session
 * that failed to start rather than as a bad number, and is the most expensive
 * shape this can fail in.
 */
export function framebufferScale(
  session: XRSession,
  layer: NativeScaleReporter | undefined = (
    globalThis as { XRWebGLLayer?: NativeScaleReporter }
  ).XRWebGLLayer
): number {
  const native = layer?.getNativeFramebufferScaleFactor?.(session);
  if (typeof native !== 'number' || !Number.isFinite(native)) return 1;
  return Math.min(Math.max(native, 1), MAX_FRAMEBUFFER_SCALE);
}
