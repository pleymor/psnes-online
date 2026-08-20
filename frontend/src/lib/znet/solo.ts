/**
 * Solo play on the lockstep stack.
 *
 * This exists so that one player gets the same core, renderer, input and
 * audio path as two players do - and so that everything built for lockstep
 * (shaders, save thumbnails, the pause menu, the display toolbar) works in
 * solo without being built twice.
 *
 * It is interesting for what it does NOT have. NetplaySession is long because
 * two machines have to stay byte-identical: a handshake, a fixed input delay,
 * a pad buffer per player, periodic checksums, desync detection, savestate
 * resync. With one player none of that means anything, and routing solo
 * through it by inventing a peer would keep every cost and every failure mode
 * while buying nothing.
 *
 * Like NetplaySession, it owns no timers. FrameGovernor decides when a frame
 * should run; this only runs it.
 */

import type { NetplayCore, TickResult, TickSource } from './session.js';

/**
 * Both controller ports for one frame.
 *
 * A pair rather than a single mask, even though `pad2` is always 0 today: the
 * SNES has two ports, RetroArch's own config maps a second physical gamepad
 * to player 2, and whether the old solo path actually supported couch co-op is
 * not something this repo can test. Keeping the pair means adding a second
 * controller later changes a caller, not this class.
 */
export interface SoloPads {
	pad1: number;
	pad2: number;
}

export interface SoloOptions {
	core: NetplayCore;
	/** Called exactly once per frame, immediately before the frame runs. */
	readLocalInput(): SoloPads;
	/** Called after a frame has run, with the new frame count. */
	onFrame?(frame: number): void;
}

export class SoloSession implements TickSource {
	private core: NetplayCore;
	private readLocalInput: () => SoloPads;
	private onFrame: (frame: number) => void;

	/**
	 * Our own count, not the core's.
	 *
	 * NetplaySession does the same: the core's frame number is the emulated
	 * machine's business, and a savestate load moves it. This counts frames
	 * this session has run.
	 */
	private frame = 0;

	constructor(options: SoloOptions) {
		this.core = options.core;
		this.readLocalInput = options.readLocalInput;
		this.onFrame = options.onFrame ?? (() => {});
	}

	get currentFrame(): number {
		return this.frame;
	}

	/**
	 * Nothing to do.
	 *
	 * The governor calls this once per slice so a netplay session can retry
	 * handshakes and send round-trip probes. There is no one to talk to here.
	 */
	pump(): void {}

	/**
	 * Runs exactly one frame.
	 *
	 * Always 'ran'. A solo session cannot stall, because stalling means waiting
	 * for a pad that has not arrived and every pad here is already in hand.
	 */
	tick(): TickResult {
		const pads = this.readLocalInput();
		this.core.runFrame(pads.pad1, pads.pad2);
		this.frame++;
		this.onFrame(this.frame);
		return 'ran';
	}
}
