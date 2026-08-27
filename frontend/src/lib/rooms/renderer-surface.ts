/**
 * The 2D-or-WebGL picture, and the shader swaps between them.
 *
 * Identical in SoloRoom and LockstepRoom down to the control flow; only the
 * comments (and one dev-log message, unified here) differed. Extracted so a
 * shader bug is fixed once.
 *
 * Holds no reactive state on purpose. Svelte 4 derives a reactive statement's
 * dependencies from the identifiers written in it, and both rooms read
 * `renderer` and `usingGl` by name from a `$:`. Moving them into this object
 * would freeze those statements at their first value, with no error and no
 * warning. So the caller keeps them as plain `let` bindings and this reports
 * changes through `onChange`.
 */
import {
	CanvasRenderer,
	WebglRenderer,
	loadShaderPreset,
	type DisplayOptions,
	type Renderer,
	type PsnesCore
} from '$lib/znet';
import type { createLogger } from '$lib/utils/logger';

export interface SurfaceState {
	renderer: Renderer;
	usingGl: boolean;
	/** Empty when the picture is 2D, whatever the caller asked for. */
	shader: string;
	notice: string | null;
}

export function createRendererSurface(opts: {
	canvas2d: HTMLCanvasElement;
	canvasGl: HTMLCanvasElement;
	/** Read at the moment a frame needs drawing; may be null before boot finishes. */
	getCore: () => PsnesCore | null;
	/** The caller's own logger, so shipped logs keep saying "SoloRoom" or "LockstepRoom". */
	logger: ReturnType<typeof createLogger>;
	onChange: (state: SurfaceState) => void;
}) {
	let renderer: Renderer | null = null;
	/** Guards against overlapping swaps when the player clicks quickly. */
	let swapToken = 0;

	/** Drops back to the 2D renderer on its own canvas. Always succeeds. */
	function useCanvas(display: DisplayOptions, notice: string | null = null): void {
		renderer?.dispose();
		/*
		 * The button reads display.shader and nothing else, so leaving it set
		 * would keep advertising a shader that is not running. The stored
		 * preference is deliberately left alone: it is the player's choice, and
		 * it should be retried on the next load rather than silently forgotten.
		 */
		const next = { ...display, shader: '' };
		renderer = new CanvasRenderer(opts.canvas2d);
		renderer.setOptions(next);
		const core = opts.getCore();
		if (core) renderer.draw(core);
		opts.onChange({ renderer, usingGl: false, shader: '', notice });
	}

	/**
	 * Switches the picture to `shaderId`, or keeps 2D and says why.
	 *
	 * Every failure lands in the same place: a working 2D renderer plus a
	 * notice. The player is never left looking at a black canvas wondering
	 * whether the game crashed - which is exactly what xbrz-freescale used to do
	 * before it was removed from the shader list.
	 */
	async function apply(shaderId: string, display: DisplayOptions): Promise<void> {
		const token = ++swapToken;

		if (!shaderId) {
			useCanvas(display);
			return;
		}

		const loaded = await loadShaderPreset(shaderId);
		// The player may have picked something else while this was fetching.
		if (token !== swapToken) return;

		if (!loaded.ok) {
			opts.logger.warn('shader unavailable', { shaderId, reason: loaded.reason });
			useCanvas(display, 'That shader could not be loaded; showing raw pixels.');
			return;
		}

		/*
		 * If WebglRenderer.create fails below, useCanvas() disposes this same
		 * (already-disposed) renderer again. That is safe: dispose() on both
		 * renderer types guards every deletion and nulls what it deletes, so
		 * nothing gets double-freed.
		 */
		renderer?.dispose();

		const webgl = WebglRenderer.create(opts.canvasGl, loaded.preset);
		if (!webgl) {
			opts.logger.warn('webgl2 unavailable or the shader would not compile', { shaderId });
			useCanvas(display, 'Shaders need WebGL2, which this browser did not provide.');
			return;
		}

		renderer = webgl;
		renderer.setOptions(display);
		const core = opts.getCore();
		if (core) renderer.draw(core);
		opts.onChange({ renderer, usingGl: true, shader: shaderId, notice: null });
	}

	/**
	 * Falls back to 2D if the GL context died mid-game.
	 *
	 * Reason-agnostic on purpose: `unusable` covers both a lost browser context
	 * and allocate() giving up (e.g. a shader's render target too large for the
	 * driver), and the player does not need to know which - both end the same
	 * way, a working 2D picture.
	 */
	function checkHealth(display: DisplayOptions): void {
		if (!renderer || !(renderer instanceof WebglRenderer)) return;
		if (!renderer.unusable) return;
		opts.logger.warn('webgl renderer unusable, falling back to 2D');
		useCanvas(display, 'Hardware shaders stopped working; showing raw pixels.');
	}

	function dispose(): void {
		renderer?.dispose();
		renderer = null;
	}

	return { useCanvas, apply, checkHealth, dispose };
}
