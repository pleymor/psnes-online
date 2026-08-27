/**
 * `renderer-surface.ts`, the 2D-or-WebGL picture Task 12 lifted out of
 * SoloRoom.svelte and LockstepRoom.svelte.
 *
 * The design rule under test: every failure path a player can hit - an empty
 * shader id, a preset that will not load, a browser with no usable WebGL2, a
 * context lost mid-game - has to leave a *working* 2D renderer behind it. A
 * player must never be staring at a black canvas wondering if the game
 * crashed. Three of those four paths also carry a notice string explaining
 * why; the fourth (no shader selected) is not a failure at all and carries
 * none, which is a real behavioural difference this suite pins down.
 *
 * Nothing here needs a browser. `CanvasRenderer` and `WebglRenderer` are the
 * real classes, driven through fake `HTMLCanvasElement`s whose
 * `getContext()` is scripted per test - same idea as `room-chrome.test.ts`'s
 * fake `document`. `loadShaderPreset` is left real too; what is faked is the
 * `fetch` it calls through, via the same globalThis-swap pattern.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRendererSurface, type SurfaceState } from '../../frontend/src/lib/rooms/renderer-surface.js';
import type { DisplayOptions } from '../../frontend/src/lib/znet/output.js';
import type { PsnesCore } from '../../frontend/src/lib/znet/core.js';

// ------------------------------------------------------------------- fakes

type Listener = (event: { preventDefault(): void }) => void;

/** Enough of `HTMLCanvasElement` for this module: `getContext`, a `style`
 * object, and (for the GL canvas) the `webglcontextlost` event. */
class FakeCanvas {
	style: Record<string, string> = {};
	width = 0;
	height = 0;
	clientWidth = 0;
	private listeners = new Map<string, Set<Listener>>();

	constructor(private contexts: Record<string, unknown>) {}

	getContext(type: string): unknown {
		return this.contexts[type] ?? null;
	}

	addEventListener(type: string, fn: Listener): void {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)!.add(fn);
	}

	removeEventListener(type: string, fn: Listener): void {
		this.listeners.get(type)?.delete(fn);
	}

	/** The real browser fires this itself when a driver resets; the fake needs telling. */
	fire(type: string): void {
		const event = { preventDefault: () => {} };
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
	}
}

/**
 * A WebGL2 context that compiles and links everything handed to it.
 *
 * `renderer-surface.ts` never calls `draw()` on a renderer unless `getCore()`
 * returns something, and every test here that wants a *working* GL renderer
 * also hands it a core whose `videoSurface()` reports a zero-sized frame -
 * enough for `WebglRenderer.draw()` to run its first line and return, without
 * needing texture/framebuffer calls this fake does not implement.
 */
function makeWorkingGl(): Record<string, unknown> {
	return {
		VERTEX_SHADER: 1,
		FRAGMENT_SHADER: 2,
		COMPILE_STATUS: 3,
		LINK_STATUS: 4,
		ARRAY_BUFFER: 5,
		STATIC_DRAW: 6,
		createShader: () => ({}),
		shaderSource: () => {},
		compileShader: () => {},
		getShaderParameter: () => true,
		deleteShader: () => {},
		createProgram: () => ({}),
		attachShader: () => {},
		linkProgram: () => {},
		getProgramParameter: () => true,
		deleteProgram: () => {},
		getAttribLocation: () => -1,
		getUniformLocation: () => null,
		createBuffer: () => ({}),
		bindBuffer: () => {},
		bufferData: () => {},
		deleteBuffer: () => {},
		deleteFramebuffer: () => {},
		deleteTexture: () => {}
	};
}

function fakeLogger() {
	const warnings: Array<{ message: string; meta: unknown }> = [];
	return {
		warnings,
		logger: {
			debug: () => {},
			info: () => {},
			warn: (message: string, meta?: unknown) => warnings.push({ message, meta }),
			error: () => {}
		} as unknown as Parameters<typeof createRendererSurface>[0]['logger']
	};
}

/** A core whose frame/surface are both zero-sized, so both renderers' `draw()`
 * returns after its first read - which is also what makes the read observable. */
function fakeCore(): { core: PsnesCore; frameReads: number[]; surfaceReads: number[] } {
	const frameReads: number[] = [];
	const surfaceReads: number[] = [];
	const core = {
		videoFrame: () => {
			frameReads.push(1);
			return { data: new Uint8ClampedArray(0), width: 0, height: 0 };
		},
		videoSurface: () => {
			surfaceReads.push(1);
			return { data: new Uint8Array(0), width: 0, height: 0, stride: 0 };
		}
	} as unknown as PsnesCore;
	return { core, frameReads, surfaceReads };
}

const DISPLAY: DisplayOptions = { aspect: 'square', shader: '' };

/** Resolves any URL ending `.glslp` with `presetText`, anything else (a shader
 * source) with `shaderText` - or rejects/fails per `fails`. */
function fakeFetch(opts: {
	presetText?: string;
	shaderText?: string;
	failPreset?: boolean;
	failShader?: boolean;
}): typeof fetch {
	return (async (url: string | URL) => {
		const href = url.toString();
		const isPreset = href.endsWith('.glslp');
		if (isPreset && opts.failPreset) {
			return { ok: false, status: 404, text: async () => '' } as Response;
		}
		if (!isPreset && opts.failShader) {
			return { ok: false, status: 404, text: async () => '' } as Response;
		}
		const body = isPreset ? (opts.presetText ?? '') : (opts.shaderText ?? '');
		return { ok: true, status: 200, text: async () => body } as Response;
	}) as typeof fetch;
}

async function withFakeFetch(impl: typeof fetch, run: () => Promise<void>): Promise<void> {
	const g = globalThis as unknown as { fetch: typeof fetch };
	const saved = g.fetch;
	g.fetch = impl;
	try {
		await run();
	} finally {
		g.fetch = saved;
	}
}

function makeSurface(opts: {
	canvasGl?: FakeCanvas;
	getCore?: () => PsnesCore | null;
}) {
	const canvas2d = new FakeCanvas({ '2d': {} });
	const canvasGl = opts.canvasGl ?? new FakeCanvas({ webgl2: null });
	const { warnings, logger } = fakeLogger();
	const states: SurfaceState[] = [];
	const surface = createRendererSurface({
		canvas2d: canvas2d as unknown as HTMLCanvasElement,
		canvasGl: canvasGl as unknown as HTMLCanvasElement,
		getCore: opts.getCore ?? (() => null),
		logger,
		onChange: (state) => states.push(state)
	});
	return { surface, states, warnings, canvasGl };
}

const ONE_PASS_PRESET = 'shaders = 1\nshader0 = pass0.glsl\n';

// -------------------------------------------------------------- failure paths

test('an empty shader id drops straight to a working 2D renderer, with no notice', async () => {
	const { surface, states } = makeSurface({});

	await surface.apply('', DISPLAY);

	assert.equal(states.length, 1);
	assert.equal(states[0].usingGl, false);
	assert.equal(states[0].shader, '');
	assert.equal(states[0].notice, null, 'nothing failed - there is nothing to explain');
});

test('a preset that fails to load falls back to 2D with a notice, and logs a warning', () =>
	withFakeFetch(fakeFetch({ failPreset: true }), async () => {
		const { surface, states, warnings } = makeSurface({});

		await surface.apply('some-shader', DISPLAY);

		assert.equal(states.length, 1);
		assert.equal(states[0].usingGl, false, 'must still be a working renderer, not no renderer');
		assert.equal(states[0].shader, '');
		assert.equal(
			states[0].notice,
			'That shader could not be loaded; showing raw pixels.',
			'the player must be told, not just silently kept on 2D'
		);
		assert.equal(warnings.length, 1);
	}));

test('no usable WebGL2 falls back to 2D with a notice, and logs a warning', () =>
	withFakeFetch(fakeFetch({ presetText: ONE_PASS_PRESET, shaderText: 'void main(){}' }), async () => {
		// getContext('webgl2') returns null - exactly what a browser reports
		// when WebGL2 is unavailable.
		const { surface, states, warnings } = makeSurface({});

		await surface.apply('some-shader', DISPLAY);

		assert.equal(states.length, 1);
		assert.equal(states[0].usingGl, false);
		assert.equal(
			states[0].notice,
			'Shaders need WebGL2, which this browser did not provide.'
		);
		assert.equal(warnings.length, 1);
	}));

test('a lost GL context is caught by checkHealth and falls back to 2D with a notice', () =>
	withFakeFetch(fakeFetch({ presetText: ONE_PASS_PRESET, shaderText: 'void main(){}' }), async () => {
		const canvasGl = new FakeCanvas({ webgl2: makeWorkingGl() });
		const { core } = fakeCore();
		const { surface, states, warnings } = makeSurface({ canvasGl, getCore: () => core });

		await surface.apply('some-shader', DISPLAY);
		assert.equal(states.at(-1)!.usingGl, true, 'the GL renderer must have taken over first');

		// The real browser fires this on the canvas when a driver resets or the
		// tab loses its context; nothing here called dispose() or apply() again.
		canvasGl.fire('webglcontextlost');
		surface.checkHealth(DISPLAY);

		assert.equal(states.length, 2, 'checkHealth must report the fallback, same as any other swap');
		assert.equal(states.at(-1)!.usingGl, false);
		assert.equal(
			states.at(-1)!.notice,
			'Hardware shaders stopped working; showing raw pixels.'
		);
		assert.equal(warnings.length, 1);
	}));

test('checkHealth is a no-op on a healthy GL renderer - no state change, no warning', () =>
	withFakeFetch(fakeFetch({ presetText: ONE_PASS_PRESET, shaderText: 'void main(){}' }), async () => {
		const canvasGl = new FakeCanvas({ webgl2: makeWorkingGl() });
		const { core } = fakeCore();
		const { surface, states, warnings } = makeSurface({ canvasGl, getCore: () => core });

		await surface.apply('some-shader', DISPLAY);
		const before = states.length;

		surface.checkHealth(DISPLAY);

		assert.equal(states.length, before, 'nothing is wrong - checkHealth must not report anything');
		assert.equal(warnings.length, 0);
	}));

test('checkHealth is a no-op while on the 2D renderer - it only ever watches GL', () => {
	const { surface, states, warnings } = makeSurface({});

	surface.useCanvas(DISPLAY);
	const before = states.length;
	surface.checkHealth(DISPLAY);

	assert.equal(states.length, before);
	assert.equal(warnings.length, 0);
});

// -------------------------------------------------------------------- swap token

test('a stale loadShaderPreset resolving after a newer request must not install its renderer', async () => {
	let resolvePreset!: (text: string) => void;
	const staleFetch: typeof fetch = (async (url: string | URL) => {
		if (url.toString().endsWith('.glslp')) {
			return new Promise<Response>((resolve) => {
				resolvePreset = (text: string) => resolve({ ok: true, status: 200, text: async () => text } as Response);
			});
		}
		return { ok: true, status: 200, text: async () => 'void main(){}' } as Response;
	}) as typeof fetch;

	const g = globalThis as unknown as { fetch: typeof fetch };
	const saved = g.fetch;
	g.fetch = staleFetch;
	try {
		const { surface, states } = makeSurface({});

		// Started first, but its preset fetch never resolves until after the
		// second request below - exactly a player double-clicking the shader list.
		const stale = surface.apply('shader-a', DISPLAY);

		// A newer request completes synchronously (empty id, no fetch involved)
		// and bumps the swap token.
		await surface.apply('', DISPLAY);
		assert.equal(states.length, 1, 'the second, newer request reported its own state');

		// Now let the stale request's fetch resolve.
		resolvePreset(ONE_PASS_PRESET);
		await stale;

		assert.equal(
			states.length,
			1,
			'the stale request must not have reported anything once a newer one had already run'
		);
	} finally {
		g.fetch = saved;
	}
});

// ------------------------------------------------------------------------ draw()

test('useCanvas draws the current core exactly once when one is live', () => {
	const { core, frameReads } = fakeCore();
	const { surface } = makeSurface({ getCore: () => core });

	surface.useCanvas(DISPLAY);

	assert.equal(frameReads.length, 1);
});

test('useCanvas does not draw when there is no core yet (before boot finishes)', () => {
	const { surface } = makeSurface({ getCore: () => null });

	// Would throw reading a null core's frame if draw() were called anyway.
	assert.doesNotThrow(() => surface.useCanvas(DISPLAY));
});

test('a successful GL swap draws the current core exactly once', () =>
	withFakeFetch(fakeFetch({ presetText: ONE_PASS_PRESET, shaderText: 'void main(){}' }), async () => {
		const canvasGl = new FakeCanvas({ webgl2: makeWorkingGl() });
		const { core, surfaceReads } = fakeCore();
		const { surface } = makeSurface({ canvasGl, getCore: () => core });

		await surface.apply('some-shader', DISPLAY);

		assert.equal(surfaceReads.length, 1);
	}));

// -------------------------------------------------------------------- dispose()

test('dispose() drops the renderer, and a later checkHealth against it is a no-op', () =>
	withFakeFetch(fakeFetch({ presetText: ONE_PASS_PRESET, shaderText: 'void main(){}' }), async () => {
		const canvasGl = new FakeCanvas({ webgl2: makeWorkingGl() });
		const { core } = fakeCore();
		const { surface, states, warnings } = makeSurface({ canvasGl, getCore: () => core });

		await surface.apply('some-shader', DISPLAY);
		surface.dispose();
		const before = states.length;

		assert.doesNotThrow(() => surface.checkHealth(DISPLAY));
		assert.equal(states.length, before, 'a disposed surface has nothing left to watch');
		assert.equal(warnings.length, 0);
	}));
