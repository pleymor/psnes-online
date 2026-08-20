/**
 * A WebGL2 renderer that runs libretro GLSL shaders.
 *
 * Same interface as CanvasRenderer, so a room picks one at boot and never
 * thinks about it again. Same shaders as the RetroArch path, from the same
 * pinned commit, so one setting looks the same in every mode.
 *
 * ONE RULE ABOVE ALL: this drives nothing. No rAF callback, no vsync
 * coupling, no dropped frames, no "draw when ready". FrameGovernor is the only
 * timer owner in this stack and NetplaySession decides when a frame exists;
 * this only shows it. A renderer that influenced pacing would make two
 * players' emulation depend on their graphics cards, which is a desync with
 * extra steps.
 *
 * The GL pipeline cannot be unit-tested in this repo - there is no WebGL
 * context under Node and no browser harness here - so it is written to fail
 * into the 2D path rather than to be caught by a test. Every failure returns
 * null or sets `unusable`; nothing here throws at the caller.
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
	/**
	 * True once the GL pipeline can no longer be trusted - a lost browser
	 * context, or `allocate()` giving up. Two different causes, one meaning:
	 * "stop calling into GL and let the room fall back to 2D." Backing field
	 * for the public `unusable` getter; it cannot share that name because a
	 * class cannot declare a field and an accessor with the same identifier.
	 */
	private isUnusable = false;
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
			// It is also load-bearing for save thumbnails: `saves/thumbnail.ts`
			// calls ctx.drawImage(sourceCanvas, …) outside the drawing frame, and
			// that only reads a real picture back because the buffer is preserved
			// rather than cleared right after compositing. Removing this for
			// performance would silently break thumbnails in GL mode.
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
			this.isUnusable = true;
		};
		canvas.addEventListener('webglcontextlost', this.onContextLost);

		this.applyOptions();
	}

	/**
	 * True once the GL pipeline is unusable - context lost, or an allocation
	 * gave up. The room watches this and swaps to 2D either way; it does not
	 * need to know which of the two happened.
	 */
	get unusable(): boolean {
		return this.isUnusable;
	}

	setOptions(options: DisplayOptions): void {
		this.options = { ...options };
		this.applyOptions();
	}

	/**
	 * Only the CSS-level options apply here.
	 *
	 * `pixelPerfect` still sets `style.imageRendering` below, same as the 2D
	 * path - what it does NOT control is GL sampling: filtering is the
	 * preset's business, set per pass from `filter_linearN`, and overriding it
	 * would make the shader look different from the same shader in the
	 * RetroArch path. `scanlines` does not apply at all - crt-easymode draws
	 * its own, and stacking a second set over a shader that already has them
	 * looks wrong.
	 */
	private applyOptions(): void {
		this.canvas.style.imageRendering = this.options.pixelPerfect ? 'pixelated' : 'auto';
		this.canvas.style.objectFit = this.options.aspect === 'stretch' ? 'fill' : 'contain';
	}

	draw(core: PsnesCore): void {
		if (this.isUnusable) return;

		const surface = core.videoSurface();
		if (surface.width === 0 || surface.height === 0) return;

		const gl = this.gl;

		if (surface.width !== this.inputWidth || surface.height !== this.inputHeight) {
			// The SNES switches between 256x224, 512x448 and interlaced modes. A
			// fixed-size texture would show noise the first time a game opens a
			// high-resolution menu. This is also where a too-large target for the
			// driver (xBRZ 6x of a 512x448 frame, above GLES3's guaranteed
			// MAX_TEXTURE_SIZE) shows up, so a false here is an ordinary outcome,
			// not a surprise - which is why it is checked rather than ignored.
			if (!this.allocate(surface.width, surface.height)) return;
		}

		// Defensive, on top of the check above: even if some future give-up path
		// inside allocate() forgets to return false, this second read of the
		// flag still keeps the pass loop below from ever running against
		// targets that were never (re)allocated.
		if (this.isUnusable) return;

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
			if (!last && !target) {
				// allocate() did not leave a target here - it should have, for
				// every intermediate pass, but this is the bail-out that replaces
				// asserting past it. The same outcome as any other give-up path:
				// stop touching GL and let the room fall back to 2D.
				this.isUnusable = true;
				break;
			}
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

	/**
	 * (Re)allocates the input texture and every intermediate render target.
	 *
	 * Returns false on any give-up path - the caller (`draw()`) must check this
	 * and bail rather than continue into a pass loop that expects a target
	 * this call did not produce.
	 */
	private allocate(width: number, height: number): boolean {
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

			const texture = gl.createTexture();
			if (!texture) {
				// A context being lost mid-allocation. Same outcome as an
				// incomplete framebuffer: give up on GL, keep the 2D path.
				gl.bindFramebuffer(gl.FRAMEBUFFER, null);
				this.isUnusable = true;
				return false;
			}
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.texImage2D(
				gl.TEXTURE_2D, 0, gl.RGBA, passWidth, passHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null
			);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

			const framebuffer = gl.createFramebuffer();
			if (!framebuffer) {
				// Same as above: the context died between the texture and the
				// framebuffer being created.
				gl.deleteTexture(texture);
				gl.bindFramebuffer(gl.FRAMEBUFFER, null);
				this.isUnusable = true;
				return false;
			}
			gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
			gl.framebufferTexture2D(
				gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0
			);
			if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
				// This is the xbrz-freescale failure, arriving from the other side:
				// a target too large for the driver (xBRZ 6x of a 512x448 frame is
				// 3072x2688, above the 2048 MAX_TEXTURE_SIZE GLES3 only guarantees).
				// Give up on GL rather than draw with a target that was never
				// created - the false returned here is what stops draw() from
				// reaching a pass loop that expects one - the room will keep the
				// 2D renderer.
				gl.deleteTexture(texture);
				gl.deleteFramebuffer(framebuffer);
				gl.bindFramebuffer(gl.FRAMEBUFFER, null);
				this.isUnusable = true;
				return false;
			}

			this.targets.push({ framebuffer, texture, width: passWidth, height: passHeight });
		}

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		this.inputWidth = width;
		this.inputHeight = height;
		return true;
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
