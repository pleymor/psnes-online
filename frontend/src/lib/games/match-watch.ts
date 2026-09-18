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
 * verdict with nothing exchanged. The verdict does now go over the wire, as
 * `match:report` (see `match-recorder.ts` and the backend's match handlers)
 * - but that is a report of an already-reached local verdict, not a source of
 * one: each peer still decides for itself, and the backend treats the two
 * peers disagreeing as the signal of a desync, not something this module
 * needs to reconcile.
 *
 * That is also why only the lockstep and VR rooms report anything today. Solo
 * has nobody to disagree with and does not arm the recorder. Dual and
 * streaming mode run the RetroArch stack, which exposes no work RAM at all, so
 * there is no verdict there rather than a one-sided one - and saying so here is
 * cheaper than someone discovering it in a room that stays silent.
 *
 * **Zero health is not the end of a match.** The knockout animation leaves the
 * loser at zero for hundreds of frames, and the menus after it never write the
 * address again, so a watcher that reports on a byte reports a dozen winners
 * for one knockout. What is watched is the transition: both sides at full
 * health arms a match, and the first zero after that decides it, once.
 *
 * **Both ports must have played.** Health alone cannot tell a versus from a
 * story mode - the computer's bar empties exactly like a player's - nor from a
 * match where the second pad was never touched. The discriminant is the
 * inputs, and it is the right one for a second reason: inputs are what lockstep
 * guarantees identical on both peers, so the guard costs the verdict none of
 * its silence.
 */

import { WATCHED_ROMS } from './watched-roms.js';
import { PAD, type PadMask } from '../znet/protocol.js';

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

/**
 * Les boutons avec lesquels on se bat.
 *
 * START et SELECT en sont exclus : ils servent à passer les écrans et à mettre
 * en pause, jamais à frapper. Les garder ferait passer la garde à un joueur 2
 * qui pianote pour sauter un dialogue, ce qui est exactement le faux positif
 * qu'elle existe pour attraper.
 *
 * Tout le reste compte, gâchettes comprises : dans Super Butouden 2, L et R
 * sont des boutons de combat.
 */
const FIGHT_BUTTONS = ~(PAD.SELECT | PAD.START);

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

	/**
	 * Quels ports ont joué depuis que le combat s'est armé.
	 *
	 * Ici et pas dans un filtre posé sur le verdict, pour deux raisons qui se
	 * cumulent : la fenêtre est celle du combat et seul `armed` sait où elle
	 * commence, et un appui doit être compté à chaque image alors que la RAM
	 * n'est lue qu'une image sur trente.
	 */
	private activity: [boolean, boolean] = [false, false];

	private wins: [number, number] = [0, 0];
	private drawn = 0;

	constructor(options: ObserverOptions) {
		this.watcher = options.watcher;
		this.readWram = options.readWram;
		this.onVerdict = options.onVerdict;
		this.sampleEvery = options.sampleEvery ?? DEFAULT_SAMPLE_EVERY;
	}

	/**
	 * Matches won, by port. Both peers count the same ones.
	 *
	 * A copy, not `this.wins` itself: this is read from `onVerdict`, by a
	 * caller entitled to keep what it is handed - a toast, a log, a test. The
	 * `readonly` on the return type only stops that caller from writing; it
	 * says nothing about `this.wins` changing under it from the next verdict
	 * onward. Handing back the live array would let a later match rewrite a
	 * score already announced. One allocation per verdict, not per frame:
	 * `score` is read at a verdict, never on the per-frame path `observe`
	 * runs.
	 */
	get score(): readonly [number, number] {
		return [...this.wins];
	}

	/** Double knockouts, which belong to neither side. */
	get draws(): number {
		return this.drawn;
	}

	/**
	 * Appelée à chaque image, avant `observe`.
	 *
	 * Deux `|=` sur des entiers masqués : c'est tout le coût sur la boucle
	 * chaude. L'ordre compte à l'image du verdict - un appui de cette image-là
	 * doit être compté avant d'être jugé.
	 */
	note(pad1: PadMask, pad2: PadMask): void {
		if ((pad1 & FIGHT_BUTTONS) !== 0) this.activity[0] = true;
		if ((pad2 & FIGHT_BUTTONS) !== 0) this.activity[1] = true;
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
			// Cette branche se reprend à chaque échantillon de pleine vie, donc
			// l'activité ne compte qu'à partir du dernier : les appuis dans les
			// menus qui précèdent le round sont écartés gratuitement.
			this.activity = [false, false];
			return;
		}

		if (!this.armed) return;
		if (!this.isPlausible(sample.p1) || !this.isPlausible(sample.p2)) return;

		const p1Down = sample.p1.current === 0;
		const p2Down = sample.p2.current === 0;
		if (!p1Down && !p2Down) return;

		this.armed = false;

		// Un port qui n'a pressé aucun bouton de combat n'a pas joué : ni le
		// processeur du mode histoire, ni le joueur 2 qui n'a pas touché sa
		// manette. Avant `wins++` comme avant `onVerdict` - un combat qui n'a
		// pas eu lieu ne compte pas non plus au score courant. `armed` s'est
		// libéré quand même : le combat est fini quelle que soit la garde.
		if (!this.activity[0] || !this.activity[1]) return;

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
