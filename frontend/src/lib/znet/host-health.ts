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

	/** One `longtask` entry, as the PerformanceObserver reports its duration. */
	noteLongTask(durationMs: number): void {
		this.blockedMs += durationMs;
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
 * The radio the device thinks it is on - `4g`, `wifi`, and so on.
 *
 * Non-standard and mostly Android, which is exactly where it is worth having:
 * a phone that changes network mid-session is otherwise invisible in the logs,
 * and telling a handover from a congested cell is guesswork without it.
 */
export function readNetType(nav: unknown): string | null {
	const connection = (nav as { connection?: { effectiveType?: unknown } } | null)?.connection;
	const type = connection?.effectiveType;
	return typeof type === 'string' && type.length > 0 ? type : null;
}

/** Heap in use, in whole megabytes. Chrome only. */
export function readHeapMb(perf: unknown): number | null {
	const used = (perf as { memory?: { usedJSHeapSize?: unknown } } | null)?.memory?.usedJSHeapSize;
	return typeof used === 'number' ? Math.round(used / (1024 * 1024)) : null;
}
