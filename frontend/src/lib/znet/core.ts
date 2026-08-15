/**
 * Typed wrapper around the deterministic snes9x wasm core.
 *
 * The whole netplay design rests on one property of this class: `runFrame` is
 * the only thing that mutates emulation state, and it takes the pads as
 * arguments. There is no polling, no timer, no hidden input path. Two
 * instances fed the same pad sequence produce the same bytes.
 */

export interface PsnesCoreModule {
	HEAPU8: Uint8Array;
	HEAP16: Int16Array;
	HEAPU16: Uint16Array;
	HEAP32: Int32Array;
	HEAPU32: Uint32Array;
	_malloc(size: number): number;
	_free(ptr: number): void;
	_pn_init(): number;
	_pn_load_rom(ptr: number, size: number): number;
	_pn_unload(): void;
	_pn_reset(): void;
	_pn_run_frame(pad1: number, pad2: number): void;
	_pn_video(): number;
	_pn_video_width(): number;
	_pn_video_height(): number;
	_pn_video_stride(): number;
	_pn_audio(): number;
	_pn_audio_frames(): number;
	_pn_sample_rate(): number;
	_pn_fps(): number;
	_pn_frame_count(): number;
	_pn_set_frame_count(frame: number): void;
	_pn_state_size(): number;
	_pn_state_save(ptr: number, size: number): number;
	_pn_state_load(ptr: number, size: number): number;
	_pn_state_crc(): number;
	_pn_sram(): number;
	_pn_sram_size(): number;
	_pn_wram(): number;
	_pn_wram_size(): number;
	_pn_wram_crc(): number;
	_pn_debug_rand(): number;
	_pn_debug_time(): number;
	_pn_debug_reset_entropy(): void;
}

export type PsnesCoreFactory = (opts?: {
	locateFile?: (path: string, prefix: string) => string;
	wasmBinary?: ArrayBuffer | Uint8Array;
}) => Promise<PsnesCoreModule>;

export interface VideoFrame {
	/** RGBA, `width * height` pixels, packed with no padding. */
	data: Uint8ClampedArray;
	width: number;
	height: number;
}

export class PsnesCore {
	private module: PsnesCoreModule;
	private romPtr = 0;
	private statePtr = 0;
	private stateCapacity = 0;
	private videoScratch: Uint8ClampedArray | null = null;
	private romLoaded = false;

	private constructor(module: PsnesCoreModule) {
		this.module = module;
	}

	/**
	 * @param factory the emscripten module factory (imported from the built glue)
	 * @param options passed through to emscripten, mainly to point at the .wasm
	 */
	static async create(
		factory: PsnesCoreFactory,
		options: Parameters<PsnesCoreFactory>[0] = {}
	): Promise<PsnesCore> {
		const module = await factory(options);
		if (!module._pn_init()) {
			throw new Error('psnes core failed to initialise');
		}
		return new PsnesCore(module);
	}

	/** Raw emscripten module, for tests that need to poke at internals. */
	get raw(): PsnesCoreModule {
		return this.module;
	}

	loadRom(rom: Uint8Array): void {
		if (this.romPtr) {
			this.module._free(this.romPtr);
			this.romPtr = 0;
		}
		this.romPtr = this.module._malloc(rom.length);
		if (!this.romPtr) throw new Error('out of memory allocating ROM');
		this.module.HEAPU8.set(rom, this.romPtr);

		if (!this.module._pn_load_rom(this.romPtr, rom.length)) {
			this.module._free(this.romPtr);
			this.romPtr = 0;
			throw new Error('core rejected the ROM');
		}
		this.romLoaded = true;
		// The state buffer is sized per game; drop any buffer sized for the
		// previous one rather than silently truncating a savestate.
		this.releaseStateBuffer();
	}

	get loaded(): boolean {
		return this.romLoaded;
	}

	reset(): void {
		this.module._pn_reset();
	}

	/** Advances emulation by exactly one frame. Pads are libretro joypad masks. */
	runFrame(pad1: number, pad2: number): void {
		this.module._pn_run_frame(pad1 & 0xffff, pad2 & 0xffff);
	}

	get frame(): number {
		return this.module._pn_frame_count() >>> 0;
	}

	set frame(value: number) {
		this.module._pn_set_frame_count(value >>> 0);
	}

	get sampleRate(): number {
		return this.module._pn_sample_rate();
	}

	get fps(): number {
		return this.module._pn_fps();
	}

	/**
	 * Copies the last rendered frame out of wasm memory.
	 *
	 * The core keeps a fixed-stride buffer; this repacks it to exactly
	 * width*height so it can go straight into an ImageData.
	 */
	videoFrame(): VideoFrame {
		const width = this.module._pn_video_width();
		const height = this.module._pn_video_height();
		const stride = this.module._pn_video_stride();
		const base = this.module._pn_video();
		const heap = this.module.HEAPU8;

		const needed = width * height * 4;
		if (!this.videoScratch || this.videoScratch.length !== needed) {
			this.videoScratch = new Uint8ClampedArray(needed);
		}
		const out = this.videoScratch;

		for (let y = 0; y < height; y++) {
			const src = base + y * stride * 4;
			out.set(heap.subarray(src, src + width * 4), y * width * 4);
		}
		return { data: out, width, height };
	}

	/** Interleaved stereo samples produced by the last `runFrame`. */
	audio(): Int16Array {
		const frames = this.module._pn_audio_frames();
		if (frames <= 0) return new Int16Array(0);
		const ptr = this.module._pn_audio() >> 1;
		return this.module.HEAP16.slice(ptr, ptr + frames * 2);
	}

	saveState(): Uint8Array {
		const size = this.module._pn_state_size();
		if (size <= 0) throw new Error('core reported no savestate size');
		this.ensureStateBuffer(size);
		const written = this.module._pn_state_save(this.statePtr, size);
		if (written <= 0) throw new Error('savestate serialisation failed');
		return this.module.HEAPU8.slice(this.statePtr, this.statePtr + written);
	}

	loadState(state: Uint8Array): void {
		this.ensureStateBuffer(state.length);
		this.module.HEAPU8.set(state, this.statePtr);
		if (!this.module._pn_state_load(this.statePtr, state.length)) {
			throw new Error('savestate deserialisation failed');
		}
	}

	/**
	 * CRC32 of the full serialised machine. Authoritative but costs a
	 * serialisation, so netplay only samples it periodically.
	 */
	stateCrc(): number {
		return this.module._pn_state_crc() >>> 0;
	}

	/**
	 * CRC32 of work RAM. Cheap enough to run every frame, which is what makes
	 * bisecting a divergence down to a single frame practical.
	 */
	wramCrc(): number {
		return this.module._pn_wram_crc() >>> 0;
	}

	sram(): Uint8Array {
		const size = this.module._pn_sram_size();
		if (size <= 0) return new Uint8Array(0);
		const ptr = this.module._pn_sram();
		return this.module.HEAPU8.slice(ptr, ptr + size);
	}

	loadSram(data: Uint8Array): void {
		const size = this.module._pn_sram_size();
		if (size <= 0 || data.length === 0) return;
		const ptr = this.module._pn_sram();
		this.module.HEAPU8.set(data.subarray(0, Math.min(size, data.length)), ptr);
	}

	dispose(): void {
		this.module._pn_unload();
		if (this.romPtr) this.module._free(this.romPtr);
		this.romPtr = 0;
		this.releaseStateBuffer();
		this.romLoaded = false;
	}

	private ensureStateBuffer(size: number): void {
		if (this.stateCapacity >= size && this.statePtr) return;
		this.releaseStateBuffer();
		this.statePtr = this.module._malloc(size);
		if (!this.statePtr) throw new Error('out of memory allocating savestate buffer');
		this.stateCapacity = size;
	}

	private releaseStateBuffer(): void {
		if (this.statePtr) this.module._free(this.statePtr);
		this.statePtr = 0;
		this.stateCapacity = 0;
	}
}
