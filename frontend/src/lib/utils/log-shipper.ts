/**
 * Ships browser logs to the backend so they can be read outside the browser.
 *
 * Diagnosing the netplay modes from console output relayed by hand is slow and
 * lossy - the interesting lines are long, they arrive on two machines at once,
 * and the useful ones are usually the ones that got truncated. Sending them to
 * the server puts both players' logs in one ordered place.
 *
 * Deliberately not a logging framework: it batches, it drops rather than
 * grows, and it never throws into the caller. A logger that can break the app
 * it is observing is worse than no logger.
 */

export interface LogEntry {
	/** ISO 8601, taken client-side so ordering survives the network. */
	timestamp: string;
	level: string;
	context: string;
	message: string;
	data?: unknown;
}

const ENDPOINT = '/api/logs';
const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH = 50;
/** Past this many pending entries we drop the oldest rather than grow. */
const MAX_PENDING = 500;

/** Identifies one page load, so two players' streams can be told apart. */
const sessionId = Math.random().toString(36).slice(2, 10);

let pending: LogEntry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let enabled = false;
let labels: Record<string, string> = {};

export function startLogShipping(extraLabels: Record<string, string> = {}): void {
	if (typeof window === 'undefined') return;
	labels = { ...labels, ...extraLabels };
	if (enabled) return;
	enabled = true;

	// A page being closed is exactly when the last few lines matter most.
	window.addEventListener('pagehide', flushWithBeacon);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flushWithBeacon();
	});
}

export function setLogLabels(extraLabels: Record<string, string>): void {
	labels = { ...labels, ...extraLabels };
}

export function ship(entry: LogEntry): void {
	if (!enabled) return;

	pending.push(entry);
	if (pending.length > MAX_PENDING) {
		// Drop the oldest: a burst means something is wrong, and the newest
		// lines describe it better than the start of the flood.
		pending = pending.slice(-MAX_PENDING);
	}

	if (pending.length >= MAX_BATCH) {
		void flush();
	} else if (!timer) {
		timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
	}
}

async function flush(): Promise<void> {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	if (pending.length === 0) return;

	const batch = pending;
	pending = [];

	try {
		await fetch(ENDPOINT, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId, labels, entries: batch })
		});
	} catch {
		// Never retry and never rethrow. These are diagnostics: losing a batch
		// costs a little insight, whereas a retry loop against an unreachable
		// server would add load exactly when things are already going wrong.
	}
}

function flushWithBeacon(): void {
	if (pending.length === 0) return;
	const batch = pending;
	pending = [];
	try {
		const body = JSON.stringify({ sessionId, labels, entries: batch });
		navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }));
	} catch {
		// Same as above: best effort.
	}
}
