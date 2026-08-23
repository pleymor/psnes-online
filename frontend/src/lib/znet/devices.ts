/**
 * Qui tient quoi.
 *
 * Deux joueurs sur une machine ne sont séparés que par cette assignation, et
 * elle vit dans le `localStorage` plutôt que sur le compte : quelles manettes
 * sont branchées est une propriété du poste, pas de l'utilisateur. Le même
 * compte sur le PC du salon et sur le portable n'a pas le même matériel.
 *
 * Le collecteur d'entrées, lui, ne connaît que des `InputSources` déjà
 * résolues - un booléen clavier et une liste d'index. Il ignore tout de
 * l'assignation, et c'est ce qui le laisse testable.
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
 * Le J1 au clavier et sur tout ce qui est libre, le J2 muet.
 *
 * C'est exactement le comportement solo actuel, et c'est voulu : un joueur
 * seul ne doit rien remarquer de ce changement.
 */
export function defaultAssignments(): Assignments {
	return {
		p1: { keyboard: true, gamepad: 'auto' },
		p2: { keyboard: false, gamepad: null }
	};
}

export const DEFAULT_ASSIGNMENTS = defaultAssignments();

/** Un joueur joue dès qu'il a de quoi appuyer. C'est toute l'activation. */
export function isPlayerActive(assignment: Assignment): boolean {
	return assignment.keyboard || assignment.gamepad !== null;
}

/** Les pads réels que le navigateur rapporte. Les pads tactiles ne comptent pas. */
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
	if (gamepad === undefined) return { ...fallback };
	return {
		keyboard: typeof source.keyboard === 'boolean' ? source.keyboard : fallback.keyboard,
		gamepad
	};
}

/**
 * Traduit `psnes-gamepad-source`, la clé d'avant.
 *
 * Elle ne connaissait qu'un joueur et une source. Le J2 arrive donc muet, ce
 * qui est le bon défaut : personne n'a demandé un second joueur.
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
			return {
				p1: normaliseAssignment(parsed.p1, defaults.p1),
				p2: normaliseAssignment(parsed.p2, defaults.p2)
			};
		} catch {
			// Une clé illisible n'est pas une raison de refuser de jouer.
		}
	}
	return migrateLegacy(storage) ?? defaultAssignments();
}

export function saveAssignments(storage: Storage, assignments: Assignments): void {
	storage.setItem(DEVICES_STORAGE_KEY, JSON.stringify(assignments));
}

/**
 * Le pad qu'une revendication explicite désigne, s'il est là.
 *
 * L'id d'abord : il survit au rebranchement, l'index non. L'index en repli :
 * deux manettes identiques partagent le même id.
 */
function resolveExplicit(assignment: GamepadAssignment, pads: PadInfo[]): number[] {
	if (assignment === null || assignment === 'auto') return [];
	const byId = pads.find((pad) => pad.id !== '' && pad.id === assignment.id);
	if (byId) return [byId.index];
	const byIndex = pads.find((pad) => pad.index === assignment.index);
	return byIndex ? [byIndex.index] : [];
}

/**
 * Ce que chaque joueur écoute, en deux temps.
 *
 * Les revendications explicites d'abord, chacune de son côté, puis `'auto'`
 * prend tout ce que l'autre joueur n'a pas pris. L'ordre est ce qui empêche la
 * définition d'être circulaire, et la redéfinition d'`'auto'` est ce qui
 * empêche une manette de piloter deux ports : pour un joueur seul, « tout ce
 * qui reste » vaut « tout », donc rien ne change.
 */
export function resolveSources(
	assignments: Assignments,
	pads: PadInfo[]
): { p1: InputSources; p2: InputSources } {
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
