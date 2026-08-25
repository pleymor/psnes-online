/**
 * Who holds what.
 *
 * Two players on one machine are separated by nothing but this assignment, and
 * it lives in `localStorage` rather than on the account: which controllers are
 * plugged in is a property of the machine, not of the user. The same account on
 * the living-room PC and on a laptop does not have the same hardware.
 *
 * The input collector, for its part, knows only already-resolved
 * `InputSources` - a keyboard boolean and a list of indices. It knows nothing
 * about assignment, and that is what keeps it testable.
 */

import type { InputSources } from '$lib/controls/binding';

export type GamepadRef = { id: string; index: number };
export type GamepadAssignment = 'auto' | GamepadRef | null;

export interface Assignment {
	keyboard: boolean;
	gamepad: GamepadAssignment;
}

export interface Assignments {
	p1: Assignment;
	p2: Assignment;
}

export interface PadInfo {
	index: number;
	id: string;
}

export const DEVICES_STORAGE_KEY = 'psnes-input-devices';
export const LEGACY_SOURCE_KEY = 'psnes-gamepad-source';

/**
 * Player 1 on the keyboard and on anything free, player 2 silent.
 *
 * That is exactly today's solo behaviour, deliberately: a lone player must
 * notice nothing about this change.
 */
export function defaultAssignments(): Assignments {
	return {
		p1: { keyboard: true, gamepad: 'auto' },
		p2: { keyboard: false, gamepad: null }
	};
}

/**
 * At most one `'auto'`, and it belongs to player 1.
 *
 * The UI only offers `'auto'` to the first player, but nothing guarantees the
 * in-memory state came from the UI: a hand-edited storage key, or a direct
 * construction that skips `loadAssignments`, can perfectly well give `'auto'` to
 * both. Without this guard `resolveSources` would then see both players as
 * having claimed nothing and hand every pad to both at once - the very symptom
 * this feature exists to remove. Player 2 is demoted silently rather than shown
 * an error: this state is unreachable through the UI, and a user who did not
 * create it has no need to hear about it.
 */
export function withSingleAuto(assignments: Assignments): Assignments {
	if (assignments.p1.gamepad === 'auto' && assignments.p2.gamepad === 'auto') {
		return { ...assignments, p2: { ...assignments.p2, gamepad: null } };
	}
	return assignments;
}

/** A player plays as soon as they have something to press. That is the whole
 * activation model. */
export function isPlayerActive(assignment: Assignment): boolean {
	return assignment.keyboard || assignment.gamepad !== null;
}

/** The real pads the browser reports. On-screen touch pads do not count. */
export function connectedPads(nav: Navigator | undefined = globalThis.navigator): PadInfo[] {
	if (!nav?.getGamepads) return [];
	const out: PadInfo[] = [];
	for (const pad of nav.getGamepads()) {
		if (!pad?.connected) continue;
		if (pad.id.includes('Virtual Gamepad')) continue;
		out.push({ index: pad.index, id: pad.id });
	}
	return out;
}

/** « 8BitDo SN30 (Vendor: 2dc8 …) » devient « 8BitDo SN30 ». */
export function padDisplayName(id: string): string {
	return id.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function normaliseGamepad(raw: unknown): GamepadAssignment | undefined {
	if (raw === null) return null;
	if (raw === 'auto') return 'auto';
	if (raw && typeof raw === 'object') {
		const ref = raw as Record<string, unknown>;
		if (typeof ref.id === 'string' && typeof ref.index === 'number') {
			return { id: ref.id, index: ref.index };
		}
	}
	return undefined;
}

function normaliseAssignment(raw: unknown, fallback: Assignment): Assignment {
	const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const gamepad = normaliseGamepad(source.gamepad);
	return {
		keyboard: typeof source.keyboard === 'boolean' ? source.keyboard : fallback.keyboard,
		gamepad: gamepad === undefined ? fallback.gamepad : gamepad
	};
}

/**
 * Translates `psnes-gamepad-source`, the key from before.
 *
 * It knew only one player and one source. Player 2 therefore arrives silent,
 * which is the right default: nobody asked for a second player.
 */
function migrateLegacy(storage: Storage): Assignments | null {
	const legacy = storage.getItem(LEGACY_SOURCE_KEY);
	if (legacy === null) return null;

	let gamepad: GamepadAssignment = 'auto';
	if (legacy === 'off') gamepad = null;
	else if (legacy !== 'auto') {
		const index = Number(legacy);
		if (Number.isInteger(index) && index >= 0) gamepad = { id: '', index };
	}

	const assignments: Assignments = {
		p1: { keyboard: true, gamepad },
		p2: { keyboard: false, gamepad: null }
	};
	storage.setItem(DEVICES_STORAGE_KEY, JSON.stringify(assignments));
	storage.removeItem(LEGACY_SOURCE_KEY);
	return assignments;
}

export function loadAssignments(storage: Storage): Assignments {
	const raw = storage.getItem(DEVICES_STORAGE_KEY);
	if (raw !== null) {
		try {
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			const defaults = defaultAssignments();
			return withSingleAuto({
				p1: normaliseAssignment(parsed.p1, defaults.p1),
				p2: normaliseAssignment(parsed.p2, defaults.p2)
			});
		} catch {
			// An unreadable key is no reason to refuse to play.
		}
	}
	return withSingleAuto(migrateLegacy(storage) ?? defaultAssignments());
}

export function saveAssignments(storage: Storage, assignments: Assignments): void {
	storage.setItem(DEVICES_STORAGE_KEY, JSON.stringify(assignments));
}

/**
 * The pad an explicit claim points at, if it is there.
 *
 * The id first: it survives replugging, the index does not. The index as a
 * fallback: two identical controllers share one id.
 */
function resolveExplicit(assignment: GamepadAssignment, pads: PadInfo[]): number[] {
	if (assignment === null || assignment === 'auto') return [];
	const byId = pads.find((pad) => pad.id !== '' && pad.id === assignment.id);
	if (byId) return [byId.index];
	const byIndex = pads.find((pad) => pad.index === assignment.index);
	return byIndex ? [byIndex.index] : [];
}

/**
 * What each player listens to, in two phases.
 *
 * Explicit claims first, each resolved independently, then `'auto'` takes
 * everything the other player did not take. The order is what stops the
 * definition being circular, and redefining `'auto'` is what stops one
 * controller driving two ports: for a lone player, "everything left" equals
 * "everything", so nothing changes.
 */
export function resolveSources(
	assignments: Assignments,
	pads: PadInfo[]
): { p1: InputSources; p2: InputSources } {
	assignments = withSingleAuto(assignments);
	const claimed = {
		p1: resolveExplicit(assignments.p1.gamepad, pads),
		p2: resolveExplicit(assignments.p2.gamepad, pads)
	};
	const unclaimedBy = (theirs: number[]) =>
		pads.map((pad) => pad.index).filter((index) => !theirs.includes(index));

	return {
		p1: {
			keyboard: assignments.p1.keyboard,
			pads: assignments.p1.gamepad === 'auto' ? unclaimedBy(claimed.p2) : claimed.p1
		},
		p2: {
			keyboard: assignments.p2.keyboard,
			pads: assignments.p2.gamepad === 'auto' ? unclaimedBy(claimed.p1) : claimed.p2
		}
	};
}

/* ------------------------------------------------------- the device choice */

/**
 * What the panel's one dropdown offers, per player.
 *
 * The stored `Assignment` can express combinations this choice cannot - a
 * keyboard and an explicit pad at once, most of all - because it predates the
 * dropdown and because `'auto'` still means "keyboard plus every free pad".
 * Keeping the stored shape untouched is deliberate: the simplification is an
 * interface change, and a data migration would be a much larger promise.
 */
export type DeviceChoice =
	| { kind: 'auto' }
	| { kind: 'keyboard' }
	| { kind: 'pad'; ref: GamepadRef }
	| { kind: 'none' };

/**
 * Reads a stored assignment back as the choice that best represents it.
 *
 * The gamepad is consulted first, so a legacy row holding both a keyboard and
 * an explicit pad shows as the pad - the more specific of the two, and the one
 * the player went out of their way to name.
 */
export function choiceOf(assignment: Assignment): DeviceChoice {
	if (assignment.gamepad === 'auto') return { kind: 'auto' };
	if (assignment.gamepad !== null) return { kind: 'pad', ref: assignment.gamepad };
	if (assignment.keyboard) return { kind: 'keyboard' };
	return { kind: 'none' };
}

/** The assignment a choice writes. One device per player, `'auto'` aside. */
export function assignmentFor(choice: DeviceChoice): Assignment {
	switch (choice.kind) {
		case 'auto':
			return { keyboard: true, gamepad: 'auto' };
		case 'keyboard':
			return { keyboard: true, gamepad: null };
		case 'pad':
			return { keyboard: false, gamepad: choice.ref };
		case 'none':
			return { keyboard: false, gamepad: null };
	}
}

/**
 * Which table the drawing shows and captures into.
 *
 * This is what replaced the Keyboard/Controller tabs: the device decides, so
 * there is nothing extra to choose. The cost is that `'auto'` tunes the
 * keyboard - to rebind a pad you select it explicitly, which also turns the
 * keyboard off for that player.
 */
export function editedTable(choice: DeviceChoice): 'keys' | 'pad' {
	return choice.kind === 'pad' ? 'pad' : 'keys';
}
