/**
 * The two players' pads and checksums, keyed by absolute frame.
 *
 * Extracted from NetplaySession because it is the half of the engine that
 * decides nothing: it holds what has been sampled and what has arrived, and
 * answers questions about it. Everything that talks to the transport, and every
 * decision about what to do when a pad is missing, stayed in the session.
 *
 * The frame numbers are absolute and shared by both peers, which is what lets a
 * pad packet be applied without knowing when it was sent.
 */
import type { PadMask } from './protocol.js';

export const PLAYER_COUNT = 2;

export class PadTimeline {
	private pads: Array<Map<number, PadMask>> = [new Map(), new Map()];
	private localCrcs = new Map<number, number>();
	private remoteCrcs = new Map<number, number>();
	private _baseFrame = 0;

	get baseFrame(): number {
		return this._baseFrame;
	}

	/**
	 * Starts a fresh timeline at `from`, with the first `inputDelay` frames
	 * primed to neutral for both players.
	 *
	 * Nobody can have sent a pad for those frames: their input would have been
	 * sampled before the epoch existed. Zero is the one value both peers are
	 * guaranteed to agree on.
	 */
	reset(from: number, inputDelay: number): void {
		this.pads = [new Map(), new Map()];
		this.localCrcs.clear();
		this.remoteCrcs.clear();
		this._baseFrame = from;
		for (let p = 0; p < PLAYER_COUNT; p++) {
			for (let f = from; f < from + inputDelay; f++) this.pads[p].set(f, 0);
		}
	}

	has(player: number, frame: number): boolean {
		return this.pads[player].has(frame);
	}

	hasAll(frame: number): boolean {
		for (let p = 0; p < PLAYER_COUNT; p++) if (!this.pads[p].has(frame)) return false;
		return true;
	}

	get(player: number, frame: number): PadMask | undefined {
		return this.pads[player].get(frame);
	}

	set(player: number, frame: number, pad: PadMask): void {
		this.pads[player].set(frame, pad);
	}

	/** The newest pad at or below `frame`, searching down to `floor`. 0 if none. */
	newestAtOrBelow(player: number, frame: number, floor: number): PadMask {
		for (let f = frame; f >= floor; f--) {
			const held = this.pads[player].get(f);
			if (held !== undefined) return held;
		}
		return 0;
	}

	/** Repeats `pad` across [from..upTo], never overwriting a real entry. */
	fillGap(player: number, from: number, upTo: number, pad: PadMask): void {
		for (let f = from; f <= upTo; f++) {
			if (!this.pads[player].has(f)) this.pads[player].set(f, pad);
		}
	}

	/**
	 * The contiguous run of `player`'s pads ending at `upTo`.
	 *
	 * A hole means history was pruned, and a run must not span one: the
	 * receiver reads the pads as consecutive from `baseFrame`, so shipping
	 * across a gap would shift every pad after it.
	 */
	runEndingAt(
		player: number,
		from: number,
		upTo: number
	): { baseFrame: number; pads: PadMask[] } | null {
		const first = Math.max(this._baseFrame, from);
		let run: PadMask[] = [];
		for (let f = first; f <= upTo; f++) {
			const pad = this.pads[player].get(f);
			if (pad === undefined) {
				run = [];
				continue;
			}
			run.push(pad);
		}
		if (run.length === 0) return null;
		return { baseFrame: upTo - run.length + 1, pads: run };
	}

	/** Frames of reserve held beyond `frame`, per player. */
	padsAhead(frame: number): number[] {
		return this.pads.map((map) => {
			let ahead = 0;
			while (map.has(frame + ahead)) ahead++;
			return ahead;
		});
	}

	setLocalCrc(frame: number, crc: number): void {
		this.localCrcs.set(frame, crc);
	}
	getLocalCrc(frame: number): number | undefined {
		return this.localCrcs.get(frame);
	}
	setRemoteCrc(frame: number, crc: number): void {
		this.remoteCrcs.set(frame, crc);
	}
	getRemoteCrc(frame: number): number | undefined {
		return this.remoteCrcs.get(frame);
	}

	/** Drops everything below `cutoff`. Pads and both checksum sides together. */
	prune(cutoff: number): void {
		if (cutoff <= this._baseFrame) return;
		for (let p = 0; p < PLAYER_COUNT; p++) {
			for (const f of this.pads[p].keys()) if (f < cutoff) this.pads[p].delete(f);
		}
		for (const f of this.localCrcs.keys()) if (f < cutoff) this.localCrcs.delete(f);
		for (const f of this.remoteCrcs.keys()) if (f < cutoff) this.remoteCrcs.delete(f);
	}
}
