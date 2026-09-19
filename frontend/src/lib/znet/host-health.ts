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
