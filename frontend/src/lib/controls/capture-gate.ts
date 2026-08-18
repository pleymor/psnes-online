/**
 * Decides when an input may be taken as a new binding.
 *
 * Binding one button at a time needs none of this: the panel listens, takes
 * the first thing it sees and stops. Binding all twelve in sequence does,
 * because the two input sources both report a held input over and over -
 * gamepads because they are polled, keyboards because the OS repeats keydown
 * - and each of those repeats would land in the next slot of the sequence.
 * Half a second of a resting thumb is enough to fill the rest of the pad with
 * one button, and what comes out is a config that is perfectly well formed
 * and simply wrong, so nothing downstream can catch it.
 *
 * The rule is the same for both sources - an input already consumed cannot be
 * consumed again until it has been let go - but only the polled source can be
 * observed being let go, which is why the two paths do not share code.
 */
export class CaptureGate {
	/** Polled codes taken already and not yet seen released. */
	private consumed = new Set<string>();

	/**
	 * Offers everything a polling tick found held down, and returns the one
	 * code to bind, if any.
	 *
	 * Takes every active code rather than just the first so that a button
	 * pressed while the previous one is still held is captured straight away.
	 * Making the player let go first would be a fair rule, but not a
	 * discoverable one: the sequence would simply appear to have frozen.
	 */
	tick(activeCodes: readonly string[]): string | null {
		for (const code of this.consumed) {
			if (!activeCodes.includes(code)) this.consumed.delete(code);
		}

		for (const code of activeCodes) {
			if (this.consumed.has(code)) continue;
			this.consumed.add(code);
			return code;
		}

		return null;
	}

	/**
	 * Offers a keydown, and returns the code to bind, if any.
	 *
	 * The repeat flag is the whole rule: it is the browser telling us this is
	 * the same press we have already seen. A key is deliberately not held in
	 * `consumed` - there is no keyup being watched to clear it, and a player
	 * is allowed to bind the same key to two buttons, which is reported as a
	 * conflict at the end just as it is when binding them one at a time.
	 */
	keydown(event: { code: string; repeat: boolean }): string | null {
		return event.repeat ? null : event.code;
	}

	/** Forgets what is held, for a sequence that starts afresh. */
	reset(): void {
		this.consumed.clear();
	}
}
