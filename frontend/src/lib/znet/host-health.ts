/**
 * What the machine is doing, as opposed to what the link is doing.
 *
 * Every field here exists to answer the first question of a bad evening:
 * network, or this machine? `strain` and `localStrain` split the late frames
 * between the two causes; these three say what the machine was doing when it
 * was the machine.
 *
 * Nothing here decides anything. It is read once a second into the telemetry
 * line and never by a loop - see `LinkMetrics`, which keeps the same rule for
 * the link's own numbers.
 *
 * The browser plumbing (the PerformanceObserver, the globals) stays in the
 * component. What lives here is the arithmetic and the contract, so both can
 * be tested without a browser.
 */

/** Blocked time on the main thread, accumulated between reads. */
export class HostHealth {
	private blockedMs = 0;
	private slowEvents = 0;
	private worstEventMs = 0;
	private worstEventName = '';
	/*
	 * Kept apart from `worstEventMs` on purpose. Event Timing's `duration` runs
	 * to the next paint, so at fifty frames a second every event clears a 16ms
	 * threshold by construction and the figure says nothing about cost. What
	 * the handler itself took is `processingEnd - processingStart`, and that is
	 * the one that accuses.
	 */
	private worstHandlerMs = 0;

	/** One `longtask` entry, as the PerformanceObserver reports its duration. */
	noteLongTask(durationMs: number): void {
		this.blockedMs += durationMs;
	}

	/**
	 * One input handler slow enough to be worth naming.
	 *
	 * `longtask` only sees blocks past 50ms, by specification, so a handful of
	 * 15 or 30ms handlers adds up to a late pad without ever showing there.
	 * Measured on 2026-09-22: both peers stalling together for 100 to 125ms
	 * while `longTasks` read zero on both. The zero never meant "nothing
	 * blocks" - it meant "nothing blocks for long".
	 */
	noteSlowEvent(name: string, durationMs: number, handlerMs = 0): void {
		this.slowEvents++;
		if (handlerMs > this.worstHandlerMs) this.worstHandlerMs = handlerMs;
		if (durationMs > this.worstEventMs) {
			this.worstEventMs = durationMs;
			this.worstEventName = name;
		}
	}

	/**
	 * The slow handlers of the interval, and the worst of them by name.
	 *
	 * Named rather than merely counted: `pointerdown` and `keydown` call for
	 * opposite investigations, and the symptom being chased appears only for
	 * one peer's inputs.
	 */
	takeSlowEvents(): { count: number; worstMs: number; handlerMs: number; worst: string | null } {
		const out = {
			count: this.slowEvents,
			worstMs: Math.round(this.worstEventMs),
			handlerMs: Math.round(this.worstHandlerMs),
			worst: this.worstEventName || null
		};
		this.slowEvents = 0;
		this.worstEventMs = 0;
		this.worstHandlerMs = 0;
		this.worstEventName = '';
		return out;
	}

	/**
	 * Milliseconds the main thread spent blocked since the last read, and
	 * resets.
	 *
	 * Per interval rather than cumulative: the telemetry ships one sample a
	 * second and each has to describe its own second. A running total would
	 * read as a machine getting steadily worse for the length of the session
	 * and would hide the bursts, which are the whole point - a frame dropped
	 * because a 300ms task ran is a different fault from a link that stuttered.
	 */
	takeLongTasks(): number {
		const blocked = Math.round(this.blockedMs);
		this.blockedMs = 0;
		return blocked;
	}
}

/**
 * The quality class the connection API reports - `slow-2g`, `2g`, `3g`, `4g`.
 *
 * It does NOT name the radio, and the name of this function is the correction
 * of a mistake: `effectiveType` means "this link behaves like...", so a good
 * WiFi connection reports `4g` for ever. Shipped as `netType` on 2026-09-19 it
 * read `4g` throughout a session where both machines were on WiFi, and the
 * name made that look like a measurement instead of a misreading.
 *
 * The physical bearer would be `connection.type`, which Chrome does not expose
 * to the page. Telling WiFi from cellular is simply not available here, and a
 * field that implies otherwise costs more than one that is absent.
 */
export function readLinkClass(nav: unknown): string | null {
	const type = connectionOf(nav)?.effectiveType;
	return typeof type === 'string' && type.length > 0 ? type : null;
}

/**
 * The downlink the connection API estimates, in Mbit/s.
 *
 * This one does move between a WiFi and a cellular link, and between two
 * qualities of cellular. Read with `readApiRtt` beside it, the pair can date a
 * change of network - which is all that was ever wanted - without pretending
 * to name it.
 */
export function readDownlink(nav: unknown): number | null {
	const value = connectionOf(nav)?.downlink;
	return typeof value === 'number' ? value : null;
}

/**
 * The round trip the connection API estimates, in ms.
 *
 * Coarse, and rounded to 25ms by the browser, so it is no substitute for the
 * session's own measurement - it describes the device's recent HTTP traffic,
 * not the pads. It earns its place by moving when the network underneath
 * changes, which the session's own figure takes some twenty seconds to admit.
 */
export function readApiRtt(nav: unknown): number | null {
	const value = connectionOf(nav)?.rtt;
	return typeof value === 'number' ? value : null;
}

function connectionOf(
	nav: unknown
): { effectiveType?: unknown; downlink?: unknown; rtt?: unknown } | undefined {
	return (nav as { connection?: { effectiveType?: unknown; downlink?: unknown; rtt?: unknown } } | null)
		?.connection;
}

/** Heap in use, in whole megabytes. Chrome only. */
export function readHeapMb(perf: unknown): number | null {
	const used = (perf as { memory?: { usedJSHeapSize?: unknown } } | null)?.memory?.usedJSHeapSize;
	return typeof used === 'number' ? Math.round(used / (1024 * 1024)) : null;
}

/**
 * How long frames took, as a shape rather than an average, and how often the
 * machine can actually present one.
 *
 * Both readings come from the same intervals, which is why they are taken
 * together rather than measured twice - and why this is not inside
 * `LinkMetrics`: solo has no peer, no link and no metrics, yet it is the mode
 * where a slowdown can be isolated without a network in the way.
 *
 * `fps` is a per-second average and reads a flat 50 straight through a burst of
 * heavy frames, which is what a player feels as a slowdown. On 2026-09-22 every
 * indicator said the machine was fine while the slowdown was plainly visible.
 * The intervals were being measured all along; saying something about their
 * shape was what was missing.
 */
export class FrameTimes {
	private gaps: number[] = [];
	private readonly window: number;
	private _quantum = 0;
	private _ms50 = 0;
	private _ms95 = 0;
	private _msMax = 0;

	constructor(window = 128) {
		this.window = window;
	}

	/** One interval between consecutive frames, in ms. */
	note(gapMs: number): void {
		this.gaps.push(gapMs);
		if (this.gaps.length >= this.window) this.close();
	}

	/**
	 * The interval at which this machine presents, measured rather than assumed.
	 *
	 * A median, never a minimum. The governor runs frames closer together
	 * whenever it catches up, and one such interval used to drag the estimate
	 * down for a whole window - the margin is a few milliseconds wide, so the
	 * 50/60 beat it exists to excuse got counted again. Four intervals in five
	 * are the refresh period; a median names it whatever the exceptions do.
	 *
	 * Zero until a window has closed, which callers read as "not yet known".
	 */
	get quantum(): number {
		return this._quantum;
	}

	get ms50(): number {
		return Math.round(this._ms50 * 10) / 10;
	}
	get ms95(): number {
		return Math.round(this._ms95 * 10) / 10;
	}
	get msMax(): number {
		return Math.round(this._msMax * 10) / 10;
	}

	/** Forgets a timeline that no longer means anything - a resync, a restart. */
	reset(): void {
		this.gaps = [];
		this._quantum = 0;
		this._ms50 = 0;
		this._ms95 = 0;
		this._msMax = 0;
	}

	private close(): void {
		const all = [...this.gaps].sort((a, b) => a - b);
		this.gaps = [];
		if (all.length === 0) return;

		const at = (q: number) => all[Math.min(all.length - 1, Math.floor(all.length * q))];
		this._ms50 = at(0.5);
		this._ms95 = at(0.95);
		this._msMax = all[all.length - 1];

		// A catch-up slice puts frames microseconds apart; those are not a
		// presentation period and must not be allowed to define one.
		const presentable = all.filter((g) => g >= MIN_PRESENT_MS);
		this._quantum = presentable.length ? presentable[Math.floor(presentable.length / 2)] : 0;
	}
}

/**
 * Below this an interval is not a presentation.
 *
 * The governor can run several emulated frames inside one tick when it is
 * catching up, and those land microseconds apart. They say nothing about how
 * often the machine can actually put a frame on screen.
 */
const MIN_PRESENT_MS = 4;
