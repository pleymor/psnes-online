/**
 * Reading the result of a versus match out of the emulated machine.
 *
 * The app has never known what happens inside a game: a match ends when a
 * player leaves the room, not when the game decides someone lost. This reads
 * the health values the game keeps in work RAM and says who won.
 *
 * Two rules shape everything here.
 *
 * **Read-only, off the emulation path.** Nothing observed may feed back into
 * `session.tick()`, the same rule the renderer obeys. In lockstep both peers
 * run the same emulation, so both read the same bytes and reach the same
 * verdict with nothing exchanged - and that is deliberate. A verdict put on
 * the wire would turn a dropped packet into a disagreement about who won a
 * match both players watched.
 *
 * That is also why only the lockstep and solo rooms report anything. Dual and
 * streaming mode run the RetroArch stack, which exposes no work RAM at all, so
 * there is no verdict there rather than a one-sided one - and saying so here is
 * cheaper than someone discovering it in a room that stays silent.
 *
 * **Zero health is not the end of a match.** The knockout animation leaves the
 * loser at zero for hundreds of frames, and the menus after it never write the
 * address again, so a watcher that reports on a byte reports a dozen winners
 * for one knockout. What is watched is the transition: both sides at full
 * health arms a match, and the first zero after that decides it, once.
 */

import { WATCHED_ROMS } from './watched-roms.js';

/** One port's health, in whatever units the game counts in. */
export interface PlayerHealth {
	max: number;
	current: number;
}

/** Both ports, as of one sample. */
export interface MatchSample {
	p1: PlayerHealth;
	p2: PlayerHealth;
}

export interface MatchVerdict {
	/** The controller port that won, or 0 for a double knockout. */
	winner: 0 | 1 | 2;
	/** Health left on each port at the sample that decided the match. */
	health: { p1: number; p2: number };
	/** The session's own frame count when the sample was taken. */
	frame: number;
}

/**
 * What one row of the per-ROM table knows.
 *
 * `read` is handed work RAM and nothing else, which is what keeps a row a
 * statement about addresses rather than a piece of game logic.
 */
export interface MatchWatcher {
	/** Uppercase CRC32 hex of the normalised dump - what `Game.crc32` holds. */
	readonly crc32: string;
	/** The dump this row was measured against, for a log line and for humans. */
	readonly rom: string;
	/** Both ports' health, or null when work RAM is too short to hold the row. */
	read(wram: Uint8Array): MatchSample | null;
}

/**
 * The watcher for a cartridge, or null.
 *
 * Null is the answer for every ROM nobody has sat down and measured, and it is
 * the honest one: the addresses of a game whose layout is unknown are not
 * missing, they are somewhere else.
 */
export function watcherFor(crc32: string): MatchWatcher | null {
	const key = crc32.toUpperCase();
	return WATCHED_ROMS.find((watcher) => watcher.crc32 === key) ?? null;
}

/**
 * The most health any of these games can be set to hold.
 *
 * A plausibility guard, not a claim about the range. Before a game has written
 * its row the bytes there are arbitrary, and arbitrary bytes that happen to
 * read as equal would arm a match that is not being played. The measured
 * handicap screen spans at least 40 to 400.
 */
const HEALTH_CEILING = 999;

/**
 * Frames between samples.
 *
 * Not per frame: `wramCrc()` runs per frame in the test harness, but a
 * production read on the hot path is a cost on the one loop that must not be
 * slowed. Half a second is nowhere near tight - the loser's health was
 * measured sitting at zero for some 850 frames after a knockout - and the cost
 * is two 16-bit reads twice a second.
 */
const DEFAULT_SAMPLE_EVERY = 30;

export interface ObserverOptions {
	watcher: MatchWatcher;
	/**
	 * A live view of work RAM. Called only on the frames actually sampled, and
	 * only for as long as the view is valid, so the caller can hand back the
	 * core's own memory rather than a copy.
	 */
	readWram: () => Uint8Array;
	onVerdict: (verdict: MatchVerdict) => void;
	/** Frames between samples. Defaults to half a second of play. */
	sampleEvery?: number;
}

/**
 * The state machine, driven from wherever the frame count already advances.
 *
 * It holds one bit: whether a match is under way. Both sides at full health
 * sets it - that is the only moment the game writes max and current together,
 * from whatever the handicap screen was left on - and the first zero after
 * that clears it and produces a verdict. Everything else it sees, the whole
 * knockout animation and every menu that follows, it says nothing about.
 */
export class MatchObserver {
	private readonly watcher: MatchWatcher;
	private readonly readWram: () => Uint8Array;
	private readonly onVerdict: (verdict: MatchVerdict) => void;
	private readonly sampleEvery: number;

	/** Whether a match is under way, i.e. whether a zero would mean anything. */
	private armed = false;

	private wins: [number, number] = [0, 0];
	private drawn = 0;

	constructor(options: ObserverOptions) {
		this.watcher = options.watcher;
		this.readWram = options.readWram;
		this.onVerdict = options.onVerdict;
		this.sampleEvery = options.sampleEvery ?? DEFAULT_SAMPLE_EVERY;
	}

	/** Matches won, by port. Both peers count the same ones. */
	get score(): readonly [number, number] {
		return this.wins;
	}

	/** Double knockouts, which belong to neither side. */
	get draws(): number {
		return this.drawn;
	}

	/**
	 * Called once per frame; reads work RAM on a schedule.
	 *
	 * The modulo is the whole cost on the frames it skips, which is what makes
	 * this safe to call from the same place the renderer draws.
	 */
	observe(frame: number): void {
		if (frame % this.sampleEvery !== 0) return;

		const sample = this.watcher.read(this.readWram());
		if (!sample) return;

		if (this.isFull(sample.p1) && this.isFull(sample.p2)) {
			// A fresh match. Also the way out of a decided one: the game writes
			// both sides back to full when the next round starts, so there is no
			// separate "the last verdict is spent" state to keep.
			this.armed = true;
			return;
		}

		if (!this.armed) return;
		if (!this.isPlausible(sample.p1) || !this.isPlausible(sample.p2)) return;

		const p1Down = sample.p1.current === 0;
		const p2Down = sample.p2.current === 0;
		if (!p1Down && !p2Down) return;

		this.armed = false;
		const winner: 0 | 1 | 2 = p1Down && p2Down ? 0 : p1Down ? 2 : 1;
		if (winner === 0) this.drawn++;
		else this.wins[winner - 1]++;

		this.onVerdict({
			winner,
			health: { p1: sample.p1.current, p2: sample.p2.current },
			frame
		});
	}

	private isPlausible(health: PlayerHealth): boolean {
		return (
			health.max > 0 &&
			health.max <= HEALTH_CEILING &&
			health.current >= 0 &&
			health.current <= health.max
		);
	}

	private isFull(health: PlayerHealth): boolean {
		return this.isPlausible(health) && health.current === health.max;
	}
}
