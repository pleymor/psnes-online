/**
 * A toy deterministic machine standing in for the emulator.
 *
 * The netplay engine's hardest bugs are not emulation bugs - they are epoch
 * handling, packet reordering, resync races. Those deserve tests that run in
 * milliseconds and need neither a 4MB wasm module nor a copyrighted ROM, so
 * this implements the same NetplayCore contract with arithmetic.
 *
 * It is deliberately input-sensitive and history-sensitive: any pad applied at
 * the wrong frame, applied twice, or skipped changes the state permanently, so
 * a test that says "in sync" really means it.
 */

import type { NetplayCore } from '../../frontend/src/lib/znet/session.js';

const WORDS = 64;

export class FakeCore implements NetplayCore {
	private ram = new Uint32Array(WORDS);
	private counter = 0;
	private readonly seed: number;
	frame = 0;

	constructor(seed = 0x1234abcd) {
		this.seed = seed;
		this.seedRam();
	}

	private seedRam(): void {
		for (let i = 0; i < WORDS; i++) {
			this.ram[i] = (this.seed + i * 0x9e3779b1) >>> 0;
		}
	}

	/**
	 * A power cycle: back to the machine this was constructed as.
	 *
	 * `NetplayCore` does not require this - a core without a reset leaves the
	 * session's `coreReset` hook null - so it is not part of the interface. It
	 * exists here because the reset path is worth testing, and because this
	 * machine is history-sensitive enough that "did it actually restart" is a
	 * question the state answers rather than one the test has to trust.
	 *
	 * `frame` is deliberately untouched, matching `loadState`'s treatment of it:
	 * the session counts its own frames, and the timeline does not rewind
	 * because the machine on it did.
	 */
	reset(): void {
		this.seedRam();
		this.counter = 0;
	}

	runFrame(pad1: number, pad2: number): void {
		// Mixing the frame number in means a pad applied one frame late leaves a
		// different fingerprint than the same pad applied on time.
		let h = (this.counter ^ Math.imul(pad1, 0x85ebca6b) ^ Math.imul(pad2, 0xc2b2ae35)) >>> 0;
		h = (h ^ (h >>> 13)) >>> 0;
		h = Math.imul(h, 0x5bd1e995) >>> 0;

		// Fold the whole machine into every step, and only ever accumulate -
		// never plain-assign. A real emulator's divergence does not heal
		// itself, and an earlier version of this fake could: a later frame
		// could overwrite the corrupted word with a value the two machines
		// agreed on, so a genuine desync silently disappeared and the netcode
		// looked correct when it had not been tested at all.
		let fold = h;
		for (let i = 0; i < WORDS; i++) {
			fold = (Math.imul(fold ^ this.ram[i], 0x27d4eb2d) + i) >>> 0;
		}

		const slot = h % WORDS;
		this.ram[slot] = (this.ram[slot] ^ fold ^ this.counter) >>> 0;
		const other = (slot + 7) % WORDS;
		this.ram[other] = (this.ram[other] + Math.imul(fold, 0x9e3779b1) + pad1 + pad2) >>> 0;
		this.counter = (this.counter + 1) >>> 0;
	}

	saveState(): Uint8Array {
		const out = new Uint8Array(WORDS * 4 + 8);
		const view = new DataView(out.buffer);
		for (let i = 0; i < WORDS; i++) view.setUint32(i * 4, this.ram[i], true);
		view.setUint32(WORDS * 4, this.counter, true);
		view.setUint32(WORDS * 4 + 4, this.frame, true);
		return out;
	}

	loadState(state: Uint8Array): void {
		if (state.length < WORDS * 4 + 8) throw new Error('short state');
		const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
		for (let i = 0; i < WORDS; i++) this.ram[i] = view.getUint32(i * 4, true);
		this.counter = view.getUint32(WORDS * 4, true);
		this.frame = view.getUint32(WORDS * 4 + 4, true);
	}

	wramCrc(): number {
		let crc = 0x811c9dc5;
		for (let i = 0; i < WORDS; i++) {
			crc = (crc ^ this.ram[i]) >>> 0;
			crc = Math.imul(crc, 0x01000193) >>> 0;
		}
		return (crc ^ this.counter) >>> 0;
	}

	stateCrc(): number {
		return this.wramCrc();
	}

	/** Test hook: corrupt the machine the way a real divergence would. */
	corrupt(): void {
		this.ram[3] = (this.ram[3] ^ 0xdeadbeef) >>> 0;
	}
}
