/**
 * The adapter between three.js's animation loop and FrameGovernor's contract.
 *
 * The governor asks for exactly one callback at a time and asks again from
 * inside the slice it just ran. three.js's `setAnimationLoop` is the opposite
 * shape: one callback, invoked every XR frame forever. This holds the pending
 * slice and hands it over once, so a frame that arrives with nothing scheduled
 * does nothing instead of replaying the previous slice - which would run the
 * emulator at the headset's refresh rate rather than the SNES's.
 *
 * Pure on purpose: no three, no XR, no clock. It is the seam that makes the
 * governor's new option testable under Bun.
 */

export interface FramePump {
	/** Handed to `GovernorOptions.schedule`. */
	schedule: (run: () => void) => void;
	/** Called once per XR frame from the animation loop. */
	pump: () => void;
}

export function createFramePump(): FramePump {
	let pending: (() => void) | null = null;
	return {
		schedule: (run) => { pending = run; },
		pump: () => {
			const run = pending;
			// Cleared before running: the slice reschedules from inside itself, and
			// clearing afterwards would throw that new callback away.
			pending = null;
			run?.();
		}
	};
}
