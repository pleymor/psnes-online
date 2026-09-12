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

/**
 * Jusqu'où on descend dans `data` à la recherche d'erreurs.
 *
 * Il en faut une : sans elle un objet cyclique ferait boucler cette fonction,
 * là où `JSON.stringify` se contente de jeter - et une exception ici casserait
 * l'application qu'on observe, ce que l'en-tête de ce module interdit. Quatre
 * niveaux couvrent `[{ phase, err }]` et ses semblables ; au-delà, la valeur
 * repart telle quelle et retrouve le sort qu'elle avait avant.
 */
const MAX_DEPTH = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Rend une valeur telle que `JSON.stringify` en garde quelque chose.
 *
 * `message`, `name` et `stack` d'un `Error` sont NON ÉNUMÉRABLES : un `Error`
 * sérialisé rend `{}`, et c'est ainsi que toutes les erreurs de ce dépôt
 * arrivaient au serveur - y compris `vr engine failed to start`, le
 * 2026-09-12, quand il fallait précisément savoir laquelle elle était.
 *
 * La conversion a lieu ici plutôt que chez l'appelant parce que c'est ce
 * module qui appelle `JSON.stringify`, donc lui seul qui sait ce qui survit au
 * voyage. Tout ce qui se sérialisait déjà passe inchangé.
 */
export function loggable(value: unknown, depth = 0): unknown {
	if (value instanceof Error) {
		const plain: Record<string, unknown> = {
			name: value.name,
			message: value.message,
			stack: value.stack
		};
		// La cause porte souvent la vraie panne, l'enveloppe n'en portant que le
		// nom. La profondeur la garde d'une chaîne qui se mordrait la queue.
		if (value.cause !== undefined && depth < MAX_DEPTH) {
			plain.cause = loggable(value.cause, depth + 1);
		}
		return plain;
	}

	if (depth >= MAX_DEPTH) return value;
	if (Array.isArray(value)) return value.map((item) => loggable(item, depth + 1));
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = loggable(item, depth + 1);
		return out;
	}

	// Tout le reste - nombres, chaînes, instances de classes, noeuds du DOM -
	// est rendu intact : ce module corrige une perte, il ne réécrit pas ce qui
	// arrivait déjà entier.
	return value;
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

	// Converti à l'entrée plutôt qu'au départ du lot : `data` est ainsi déjà
	// sérialisable quel que soit le chemin qui l'emporte - `fetch` ou la balise
	// de `pagehide` - et l'erreur est figée au moment où elle a été journalisée
	// plutôt que deux secondes plus tard.
	pending.push(entry.data === undefined ? entry : { ...entry, data: loggable(entry.data) });
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
