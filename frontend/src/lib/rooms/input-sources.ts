/**
 * Points each player's collector at whatever device is currently assigned.
 *
 * Called on every gamepad connect and disconnect, and once when the pause menu
 * closes: `ControlsSettings` writes a device assignment straight to storage
 * without dispatching anything, so this is the one place a device reassigned
 * while paused reaches the running collectors.
 *
 * Returns the pad count rather than deciding about the touch pad. Whether a
 * drawn pad is wanted is the component's call, and the two rooms answer it
 * differently.
 */
import { connectedPads, loadAssignments, resolveSources, type Assignments } from '$lib/znet';
import type { InputSources } from '$lib/controls/binding';

export interface SourceTarget {
	setSources(source: InputSources): void;
}

export function applyInputSources(
	storage: Storage,
	collectors: (SourceTarget | null)[]
): { assignments: Assignments; padCount: number } {
	const assignments = loadAssignments(storage);
	const pads = connectedPads();
	const sources = resolveSources(assignments, pads);
	const perPlayer = [sources.p1, sources.p2];
	collectors.forEach((collector, i) => collector?.setSources(perPlayer[i]));
	return { assignments, padCount: pads.length };
}
